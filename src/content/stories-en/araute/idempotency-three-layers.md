---
title: Reserving the ID before charging so a retry never becomes a second charge
summary: "A request repeated because of a network drop, a deploy or a queue can't become a second charge. I designed idempotency into each of those boundaries, and repeating a request returns the first one's result instead of charging again."
project: araute
order: 1
tags: [Idempotency, Idempotency-Key, PostgreSQL, Cloudflare Queues, Payments]
---

A merchant creates a R$ 150.00 charge through the API. The request goes out, their server's network flickers and the HTTP client gets no response. The library does what every library does: it tries again. On Araute's side, the first request had already arrived and was talking to the payment provider. If the second POST is treated as new, the buyer gets two charges, and the merchant finds out through support.

## The problem

Charging twice is the worst bug in a payments platform, and it doesn't have a single origin. The API client repeats the POST because the network dropped. The Worker is restarted mid-request because of a deploy. The queue delivers the same message twice. The provider resends the same webhook. Each source of duplication happens at a different boundary of the system, so a single defense at the API edge doesn't cover the others.

## Why it wasn't trivial

Three factors add up.

The first is distributed execution. Many Cloudflare Workers isolates (lightweight, ephemeral runtime instances with no shared memory between them) serve requests at the same time. An in-memory lock is useless. The lock has to live in the database.

The second is queue delivery. Cloudflare Queues guarantees at-least-once delivery, never exactly-once. Every consumer has to accept the same message repeated without repeating the effect.

The third is the trickiest. The call to the provider also needs an idempotency key, and that key has to be the same across attempts. If it's derived from an ID generated inside the business logic, each re-execution generates a new ID, a new key, and the provider creates a second resource in good faith.

## The solution

I split the problem into three independent layers, each with its own key and validity window.

### Layer 1: the public API

Every POST that creates or charges requires the `Idempotency-Key` header. The rule is in the [public documentation](https://docs.araute.com/comece-aqui/idempotencia): same key and same body return the original response; same key with a different body returns 422, because it's a usage error; a key still being processed returns 409.

Internally, the key's own row in the database is the lock, unique per account and per endpoint. It stores a SHA-256 hash of the body in canonical form, which makes it possible to tell a legitimate replay from improper reuse even if the JSON arrives with its keys in a different order.

2xx and deterministic 4xx responses are stored for replay. 5xx responses aren't. A transient error can't stay glued to the key for three days: the client must be able to repeat the same key and actually re-execute.

### Layer 2: the call to the provider

The key sent to the provider is deterministic and derived from an internal ID that's already persisted, never from a random value generated at call time. A retry is only safe with the same key.

### Layer 3: ingestion and queues

The provider's raw event is deduplicated by the pair provider and event ID. Queue jobs are idempotent by the natural key of the effect: a subscription renewal is unique per subscription and period start, so reprocessing the job doesn't create a second invoice.

### The gap between layer 1 and layer 2

While reviewing the design, I found a hole in the sentence "the key is derived from an already persisted ID". It didn't say when that ID was born. If it were generated while the business logic ran, the scenario below produced a double charge: the Worker creates the payment at the provider, dies before storing the response, and the retry finds an orphaned lock (a reserved key whose request never finished). On resuming, the logic generates another ID, another provider key, and the provider charges again.

The fix was to take ID generation out of the business logic. The resource ID is now reserved in the same row as the idempotency key, in the same INSERT that takes the lock, before any external I/O. Every execution for that key reads that ID instead of creating another.

## An example

The snippet below is a simplified version of the reservation. The key point is that the ID is born together with the lock, in SQL, not inside the service.

```ts
async function reserveKey(db: Db, req: IncomingRequest) {
  const row = await db
    .insertInto('request_locks')
    .values({
      accountId: req.accountId,
      endpoint: req.endpoint,
      key: req.idempotencyKey,
      bodyHash: sha256(canonicalJson(req.body)),
      // the aggregate ID is born here, with the lock, so every retry reuses it
      resourceId: sql`uuidv7()`,
    })
    .onConflict((oc) => oc.columns(['accountId', 'endpoint', 'key']).doNothing())
    .returning(['id', 'resourceId'])
    .executeTakeFirst()

  if (row) return { kind: 'fresh', resourceId: row.resourceId }
  return { kind: 'existing' } // replay, 409 in flight, or resume an orphan
}
```

And the timeline of the case that motivated the change, with and without the reservation:

| Moment | Without reservation | With reservation |
| --- | --- | --- |
| t=0 | POST arrives, lock created | POST arrives, lock created with ID `01J...A7` |
| t=30ms | service generates ID `X`, charges at the provider with key `X` | service uses `01J...A7`, charges with key `01J...A7` |
| t=900ms | Worker restarted before storing the response | Worker restarted before storing the response |
| t=5s | retry resumes the orphaned lock | retry resumes the orphaned lock |
| t=5.03s | service generates ID `Y`, charges with key `Y` | service reads `01J...A7`, calls the provider with the same key |
| Outcome | two charges | the provider returns the existing charge |

For operations that move money out, like refunds and payouts, I was more conservative: an orphaned lock isn't resumed. The API responds 409 with a specific code and the client has to decide consciously, with a new key.

## Result

A retry became a replay, never a second execution. The rule was recorded as a project invariant: re-executing a creation while relying on the provider's deduplication, with a key generated by the execution itself, is forbidden. That also became a criterion for choosing providers. An adapter whose provider doesn't support lookup by a key of ours has to solve idempotency another way. "Look up before creating" is not a substitute, because it opens a race window between the lookup and the creation.

## What I take from it

Idempotency isn't a header. It's a property of every boundary where repetition can happen: the API, the external call, the queue, the webhook. And the key for an internal boundary has to exist before the first attempt, not be generated during it. When I design a new flow, the first question I ask is: if this process dies on the next line, what will the next attempt read?
