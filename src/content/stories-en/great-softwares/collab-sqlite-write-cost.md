---
title: Collaborative editing on a Durable Object, without losing work and with minimal writes
summary: "So several people could edit the same Great Pages page at once, I built rooms on Durable Objects with an authoritative server. Then I measured the SQLite write cost in tests and refined the design until reopening a page went from 659 rows written to 2."
project: great-softwares
order: 1
tags: [Durable Objects, WebSocket, Real-time collaboration, SQLite, Cost]
---

Imagine an agency building a client's landing page. The designer tweaks the colors at the top while the copywriter changes the form text, each on their own computer. In an editor made for a single person, both click save ten seconds apart, and whoever saved last wins: the other's work vanishes without warning. That was the scenario real-time editing had to make impossible.

## The problem

The Great Pages visual editor was born for a single person. It opened the page, kept everything in memory and, on save, sent the whole document back. With two people, that's a race: the last document sent overwrites the previous one, even if the two touched different parts.

I needed several people to edit the same page at the same time, seeing each other's cursor and selection, without losing work. And there was a second, less visible requirement: the chosen storage bills per **row written**, so the cost of a room had to follow what people edit, not how many times they come and go.

## Why it wasn't trivial

Four collaboration constraints pressed together.

- **Someone has to order the changes.** If each client decides the order of edits on its own, the states diverge and never converge again.
- **A long-lived connection is expensive.** A process kept awake just to hold an idle WebSocket is money down the drain. An idle room has to sleep.
- **The editor runs on custom domains** for whitelabel accounts (the partner's brand, the partner's domain). The WebSocket to the collaboration service is a cross-site connection, and the session cookie doesn't travel with it.
- **Large document.** A page easily exceeds hundreds of KB, and the value of a key in a Durable Object's storage has a 2 MB ceiling.

And the embedded SQLite billing has rules that aren't intuitive:

- inserting into a regular table writes the row and also the primary key index row, plus one more per secondary index;
- `DELETE` counts one row per deleted row;
- an upsert whose `WHERE` clause prevents the update writes zero rows;
- `setAlarm`, which schedules the object's next wake-up, counts as one row.

## The solution

### One room, one object

A **Durable Object** is an object with state and a unique address that Cloudflare guarantees exists as a single instance in the world. That gave me the single point of ordering for free: I created one object per room, identified by the page and the A/B test variant.

The object accepts sockets through the WebSocket Hibernation API. With it, the runtime can take the object out of memory while the room is quiet and wake it when a message arrives. The keepalive is a `ping` automatically answered with `pong` by the runtime itself, without waking the object.

### Authoritative server and small operations

The client doesn't send the document. It sends batches of operations (`SET`, `CREATE`, `DELETE`) with a batch identifier. The server applies last-writer-wins **per property**: if two people touch different properties, both changes stay. It responds `ACK` to the author and relays the operations to the others. The order of blocks on the page is just another property, so the server has no layout logic at all.

The document lives in the object's own SQLite, **one row per entity** instead of a single blob. An edit writes only the row that changed, and the 2 MB per-value ceiling stops mattering.

### Entry by ticket

The browser never sees the session token. The editor's server, which reads the `httpOnly` cookie, asks the collaboration service for a ticket. The service checks the session, decides the role (editor or read-only, the latter when the profile is read-only or an A/B test is running) and writes a random 256-bit ticket valid for 60 seconds. The browser opens the WebSocket with only that ticket, and redemption reads and deletes the ticket in the same transaction, so it never opens two sockets.

### Protocol details

- **Refusal with a reason.** The browser doesn't expose the HTTP status of a refused WebSocket upgrade. When the room can't open (full, page deleted), I accept the socket, send an error message with the reason and close with a custom code.
- **Frames after closing.** After the server closes a socket, the runtime still delivers frames the client sent earlier. I mark the closing in the socket's metadata and discard those frames. `readyState` doesn't work, because it also changes when the client is the one closing, and a valid batch sent just before would be thrown away.
- **A permanent refusal doesn't erase work.** The room writes back to the API in the background. A network failure reschedules with backoff of 5, 15, 60 and 300 seconds. A permanent refusal (frozen account, deleted page) doesn't reschedule on its own, but it doesn't discard anything either. The first version cleared the state in that case so the room could close. I replaced it with a quarantine that keeps the document until someone reopens it, because losing the user's work is always worse than keeping an object alive.

### The second pass on the design: measuring what the room writes

With the protocol working, I wrote a suite that runs inside workerd, the real Workers runtime, and reads the rows-written counter the object's SQLite exposes. Each scenario (open a room, reopen, one batch, a burst) got a **ceiling** of rows. The measurement showed three drains adding up in the first version: the document was deleted when the last participant left and rewritten in full on the next entry, the sequence counter was written on every batch, and each batch re-armed the write-back alarm. Each adjustment below came in along with its new ceiling, so the cost can't come back without a test breaking.

1. **The room doesn't reset when it empties.** This was the biggest gain. Deleting the document on exit looked like hygiene, but it forced reinserting everything on reopen. Now the room keeps the document, re-reads the saved version and does a guarded upsert: an identical entity writes nothing, and only entities that left the document are deleted. The room expires after 90 days empty and with no pending work, with the alarm aligned to midnight UTC so several entries on the same day don't rewrite it.
2. **Lease on the sequence counter.** Each batch gets a number that must never repeat, not even after the object sleeps and wakes. I reserve blocks of 100, write only the block's ceiling and keep the current value in memory. I ruled out using the clock as the sequence, because that depends on a monotonic clock across machines when the object migrates.
3. **Alarm only when needed.** The write-back uses a 3-second debounce with a 15-second cap. The object remembers when the current alarm fires and only calls `setAlarm` if it doesn't cover the new deadline.
4. **WITHOUT ROWID table.** A regular table stores rows by a hidden `rowid` and keeps a separate index for the primary key. With `WITHOUT ROWID`, the table becomes the key's own tree, and an insert writes one row instead of two. New rooms are born this way, and since no query uses `rowid`, going back to the previous version of the code doesn't require a migration.

## An example

A concurrent edit, with two tabs in the same room:

| Time | Tab A (designer) | Tab B (copywriter) | Server |
| --- | --- | --- | --- |
| t=0 | `SET hero.background = #0f172a` | | applies, `seq=41` |
| t=8ms | | `SET form.title = "Fale com a gente"` | applies, `seq=42` |
| t=10ms | receives `ACK 41` and `OPS 42` | receives `OPS 41` and `ACK 42` | |
| t=30ms | `SET form.title = "Contato"` | | applies, `seq=43`, wins by being the last on the same property |

Different properties never fight, and the same property has a deterministic winner that both tabs see.

The counter lease, in a minimal version:

```ts
const SEQ_LEASE = 100;

class SeqCounter {
  private current: number;
  private ceiling: number;

  constructor(private sql: SqlStorage) {
    const row = sql.exec('SELECT ceiling FROM seq_lease').toArray()[0];
    // Resume from the ceiling, not the last value used: whatever was only in memory was lost.
    this.ceiling = Number(row?.ceiling ?? 0);
    this.current = this.ceiling;
  }

  next(): number {
    this.current += 1;
    if (this.current > this.ceiling) {
      this.ceiling = this.current + SEQ_LEASE - 1;
      this.sql.exec('INSERT OR REPLACE INTO seq_lease (id, ceiling) VALUES (1, ?)', this.ceiling);
    }
    return this.current;
  }
}
```

Over 250 batches, this writes the ceiling 3 times instead of 250. After a hibernation at batch 130, the next sequence is 201: a jump, never a repeat, and the editor accepts the jump.

And the combined effect of the four adjustments, measured in the suite with a test document of about 200 entities:

| Scenario | First version | Final design |
| --- | --- | --- |
| Reopen room with identical document | 659 rows | 2 rows |
| First opening of the document | 455 rows | 242 rows |
| Next batch within the flush window | 3 rows | 1 row |
| Burst of 50 `SET` | 150 rows | 50 rows |

## Result

The room hibernates when nobody is editing, the state doesn't depend on an external database on the hot path, and the editor reconnects with a new ticket without exposing credentials to the browser's JavaScript. The cost per room follows what people actually edit. Messages have Zod schemas validated against the same examples in the service and in the editor, and the tests run in the real runtime: a real WebSocket upgrade, a session with two participants, a refused room, reopening and the rows-written ceilings.

## What I take from it

An authoritative server with small, idempotent operations solves almost everything else about collaboration. On a platform that bills per write, I measure writes the way I measure latency: with a test and a ceiling per operation. And testing a Durable Object only with fakes hides integration problems: an error in the URL used to forward to the object only showed up once I started running the suite in the real runtime.
