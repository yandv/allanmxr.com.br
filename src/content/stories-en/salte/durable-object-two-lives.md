---
title: "Deploying a Durable Object in the middle of a conversation: the old life has to go quiet"
summary: "At Cloudflare, the old version of a Durable Object stays alive for a while after a deploy, next to the new one. For the agent chat, I designed a superseded state: the old life retires itself, the new one tidies up, and the screen of whoever is chatting recovers without a reload."
project: salte
order: 24
tags: [Durable Objects, SSE, Cloudflare Workers, Concurrency, Deploy]
---

Someone is in the middle of a conversation with the agent right at deploy time. Ideally they don't even notice: the screen blinks, reconnects and shows the conversation as it is. What can't happen is the same reply showing up twice, or a turn staying marked as "running" forever. Guaranteeing that meant dealing with a platform detail that almost nobody notices until they design for it: during the swap, there are two instances of the same object.

## The problem

Each organization has a Durable Object that coordinates the chat with the agent. A Durable Object, at Cloudflare, is an object with a unique identity: every request for that id lands on the same instance, which keeps state in memory and has its own storage. The coordinator maintains a request queue, the turns in progress and the viewers connected over SSE (Server-Sent Events, a one-way HTTP stream from the server to the browser).

In a deploy, the object has two lives running together for a while: the old one, still with open streams, and the new one, just created. In deploy tests with open conversations, this showed up concretely: without a swap protocol, both could write to the same conversation. The version swap had to be a designed state, not a coincidence.

## Why it wasn't trivial

When Cloudflare swaps the code of a Durable Object, the old instance doesn't die right away. It stays alive as long as some request or stream holds it. From the old code's point of view, nothing changed: it has its in-memory queue, a turn in progress, connected viewers and a database connection.

The only sign that it has been replaced is a storage reset error, and that error only shows up when it tries to use storage. An object busy streaming and calling the database can go a good while without touching storage.

Meanwhile, the new life rebuilds what it needs from PostgreSQL. Everything the old one keeps in memory is stale and only gets in the way.

## The solution

### "Life superseded" as a state

I gave the object an explicit superseded state. On the first storage reset error, the old life isolates itself:

1. aborts the running turn and any parallel turns;
2. empties the in-memory queue, because the new life rebuilds it from the database;
3. closes all viewers, and the browser reconnects to the new life;
4. stops the clocks and timers;
5. closes the database connection;
6. and from then on refuses any chat write with its own error.

### Don't wait for the stumble

So as not to depend on the old life bumping into storage by chance, while it has connected viewers it probes storage at short intervals. A reset error triggers the isolation. Any other failure is only logged, so a network hiccup doesn't take down a healthy life.

### The successor tidies up

The new life runs, exactly once, a recovery of what the previous one left behind. Turns and calls marked as "running" are closed. Half-finished writes become an explicit failure, instead of vanishing. The requests the previous life cut off go back on the queue. And they can only run again because the previous life is guaranteed to be silent.

### Verifiable deploy

The Worker and the object report the id of the running version. The deploy smoke test waits until the health endpoint shows the version that the deploy tool says it published.

### In the browser

The browser's `EventSource` only reconnects on its own on a network drop. If the server responds with an error, which is what happens during a deploy, it gives up. So the front end reconnects on its own, with growing backoff. It renews the session once per drop, not on every attempt, because always renewing turned into a refresh loop until the API applied rate limiting. And there's a watchdog: the server sends periodic pings, and if the channel goes 50 seconds without any event, even without an error, the front end closes and reopens the connection. After reopening, it reloads the conversation state, because events may have gone by while the channel was silent.

## An example

The timeline below is illustrative, with approximate times, and shows a deploy in the middle of a conversation, without and with the superseded state.

Without the superseded state:

| Time | Event |
| --- | --- |
| t=0 | Deploy published. Life A keeps an open stream and a running turn. |
| t=2s | A new message arrives and creates life B, which reads the queue from the database and starts the same request. |
| t=5s | A finishes its turn and writes the reply. B writes its own. The chat shows two replies. |
| t=8s | B marks A's turn as "running", because it doesn't know A finished. It stays that way. |

With the superseded state:

| Time | Event |
| --- | --- |
| t=0 | Deploy published. Life A keeps an open stream. |
| t=1s | A probes storage and gets a reset error. It enters the superseded state. |
| t=1s | A aborts the turn, closes the streams and stops accepting writes. |
| t=1.2s | The browser gets an error, waits and reconnects. The connection creates life B. |
| t=1.5s | B runs recovery: closes the pending turn and puts the request back on the queue. |
| t=2s | B runs the request once. The browser reloads the chat and shows the right state. |

The core of the isolation is small. In a simplified version:

```ts
async function guard<T>(write: () => Promise<T>): Promise<T> {
  if (this.superseded) throw new ObjectReplacedError();
  try {
    return await write();
  } catch (error) {
    if (isStorageReset(error)) {
      // this life no longer knows what's true; the successor rebuilds from the database
      this.supersede();
      throw new ObjectReplacedError();
    }
    throw error;
  }
}
```

Every chat write goes through this guard. The old life may even receive a late request, but it no longer writes anything.

## Result

Two lives no longer write to the same conversation. Whoever has the screen open during a deploy sees the reconnection happen on its own and finds the correct state. I covered the isolation with a unit test that simulates the storage reset, and the smoke test confirms the new version is actually live before considering the deploy done.

## What I take from it

In systems with long-lived objects, replacement has to be a designed state, not an accident. Whoever knows it was replaced goes quiet. The successor rebuilds from a source of truth that isn't anybody's memory. And on the client side, a silent stream should be treated as a broken stream.
