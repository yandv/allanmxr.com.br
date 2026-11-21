---
title: "Clinic internal chat: writes over REST, WebSocket only to notify"
summary: "The clinic team needed to talk inside the system, about patients, without messages going through a shortcut with fewer rules than the rest of the API. I made every write go through REST and left the WebSocket only for notifying."
project: salte
order: 8
tags: [WebSocket, Durable Objects, PostgreSQL, AES-GCM, Real time]
---

A nurse finishes triage and wants to tell the doctor that the patient in room 3 arrived with high blood pressure. Today she'd do it on her personal WhatsApp, with the patient's name in a conversation the clinic doesn't control. When Salte got an internal chat, the request was simple: one-to-one conversation between professionals of the same clinic, with audio, documents, read receipts and a "typing" indicator. The hard part was doing it without opening a side door in the API.

## The problem

Chat seems to call for WebSocket for everything: the client sends the message over the socket, the server stores and distributes it. In a healthcare ERP, that creates a second write path. Salte's REST API already had, on every route, authentication, clinic membership checks, rate limiting, body validation and a transaction. A message handler on the socket would have to repeat all of that, and any omission would become a way to write clinical data without the rules of the rest of the system.

There was also the data itself. Messages between professionals talk about patients. They can't sit in plain text in the database or in a public file.

## Why it wasn't trivial

On Cloudflare Workers, a long-lived WebSocket connection lives in a Durable Object, an object with a unique identity and its own state that Cloudflare guarantees exists as a single instance at a time. That solves distribution, but it tempts you to put too much logic in there: validating, encrypting, writing to Postgres. Doing that funnels the entire conversation into a single instance and duplicates code that already exists in the Worker.

The real-time details bite too. Two people opening the same conversation at the same time can create two conversations. A late read receipt can "unread" messages. And a socket that drops has to come back without losing anything.

## The solution

### REST writes, the socket only pushes

Every persistent change goes through a REST route: send, edit, delete, react, mark as read, pin. They go through the same stack as any other route: authentication, conversation membership, rate limiting, Zod validation and a transaction. The WebSocket is outbound only. A message arriving from the client over the socket is deliberately ignored. Even "typing" goes over REST, with a signal every four seconds and a five-second validity.

This is the design Slack, Discord and Linear use, and it's not a compromise. The rule is written in the module's documentation: if an event needs validation, permission or persistence, it's a REST route, never a socket message.

### One Durable Object per clinic, with no database access

Each clinic has a Durable Object that works as a distribution hub. Each person opens a single socket per clinic, and it carries the events of all their conversations; the client reads the conversation id from the event to know where to render it. The object doesn't talk to the database. It keeps only ephemeral state: who's typing and who's online.

After REST writes to Postgres, the Worker asks the object to notify the participants, always excluding whoever originated the event, who already has the result in the HTTP response. If the object fails, the REST response still stands, and the other participants catch up on reconnect, fetching messages since the last cursor. Postgres is the source of truth; the socket is a delivery shortcut.

### Content encrypted in the service layer

The message text and the media file key are stored encrypted with AES-256-GCM. Encryption happens in the service layer: the repository receives and returns bytes and knows nothing about cryptography. Audio, images and documents go to R2 with no public URL and no presigned link. Download goes through the Worker, with the same authentication as any route.

### One conversation per pair, decided by the database

A direct conversation has a key derived from the pair of people, always computed with the ids in order, so that "A talks to B" and "B talks to A" give the same key. A partial unique index guarantees one conversation per pair within the clinic. If two requests race, one inserts, the other gets a uniqueness violation and reads the conversation that was just born.

### Read receipts that only move forward

The "read up to here" pointer only advances. The update has the condition that the new id is greater than the current one, and since the ids are UUIDv7, ordered by time, comparing ids is comparing moments. A late or malicious client can't move the pointer back and inflate other people's unread counters. If nothing advanced, no event is distributed.

## An example

A made-up timeline, with the nurse (N) and the doctor (D) in the same clinic:

```text
t=0 ms     N sends "Room 3 patient with BP 160/100" via POST
t=0 ms     authentication, conversation membership, rate limit, validation
t=6 ms     text encrypted, INSERT in the transaction, COMMIT
t=7 ms     201 response to N, with the message already built
t=8 ms     Worker asks the clinic's object: notify D, exclude N
t=9 ms     D receives "message:new" over the socket and renders the bubble
t=2 s      D opens the conversation: read POST with the message id
t=2 s      UPDATE advances the pointer; N receives "receipt:read"
```

The read pointer is protected like this:

```sql
UPDATE participants
   SET last_read_id = $3
 WHERE conversation_id = $1
   AND user_id = $2
   AND (last_read_id IS NULL OR last_read_id < $3);
-- 0 rows affected: stale receipt, nothing to distribute
```

If D's socket were down at 9 ms, nothing would be lost: on reconnect, the app asks for messages after the last cursor it knows and receives the nurse's message from Postgres.

## Result

The clinic got a chat with audio, documents, reactions, replies, delivery and read receipts and online presence, and none of those features opened a write path outside the API's rules. Whoever loses their clinic membership also loses chat access, through the same check that protects the rest of the API. I also wired the web front end's messages screen to the new API, with media upload and an audio waveform computed on the client.

The data model already supports group conversations, even though the product starts with one-to-one. I left that on record so nobody simplifies the schema and closes that door.

## What I take from it

Real time doesn't need a second backend. When the write path already has the right rules, the socket can be just a notice that something changed, and the truth stays in one place. Distribution is best effort; persistence is not.
