---
title: Notifying the merchant only of what the database has committed, with an outbox and per-endpoint delivery
summary: "A webhook fired before the commit can announce to the merchant a payment that the rollback undoes, and they release an order that was never paid. I write the event in the same transaction as the payment and send it only after the commit, with guaranteed redelivery when their system is down."
project: araute
order: 3
tags: [Webhooks, Transactional outbox, HMAC, Cloudflare Queues, PostgreSQL]
---

Picture a merchant who receives the `payment_intent.succeeded` event at 10:15 am for an R$ 240.00 order. Their system releases the order and sends the product to picking. Ten minutes later, their team queries the API to issue the invoice and doesn't find the payment confirmed. The webhook would have gone out in the middle of the request, and the transaction that changed the state would have rolled back right after. The merchant would be told about a state that never reached the database. That's the scenario the delivery design had to make impossible.

## The problem

Araute notifies the merchant by webhook whenever an object changes state: payment confirmed, subscription renewed, invoice issued. The contract looks simple, but the moment of dispatch matters. If the notice goes out before the transaction commits, any failure after it produces a phantom event. And a single phantom event is enough for the merchant to stop trusting all the others.

## Why it wasn't trivial

Reliable webhook delivery has several tensions at once.

The merchant's endpoint can be down for hours or days, and events from that period can't be lost. A slow endpoint can't delay delivery to other merchants. The signing secret has to be rotatable without breaking whoever has already integrated. And since the arrival order between different events isn't guaranteed in a delivery with retries, the event format has to work for consumers who deduplicate and re-query state.

Finally, in Cloudflare Workers, background work is usually scheduled with `waitUntil`, which runs regardless of the transaction's fate. A `waitUntil` scheduled mid-request survives a rollback.

## The solution

### Outbox in the same transaction

The event is written in the same transaction that changes the object's state. This is the transactional outbox pattern: instead of calling the outside world from inside the transaction, I write the intent to a table, and something reads that table later. If the transaction rolls back, the event disappears along with the state change. If it commits, both exist.

### Side effect only after commit

For dispatch, the HTTP layer opens the request's transaction and offers a variation of `waitUntil` that only schedules the task after the commit. On rollback, the task is discarded. That way, enqueuing deliveries on Cloudflare Queues never happens for a state that doesn't exist.

### One delivery per endpoint

Each event generates one delivery for every endpoint subscribed to that event type, and the retry schedule is per delivery. A slow or down endpoint accumulates its own attempts without affecting the others. A delivery has four states: pending, success, failed (which gets retried while there's schedule left) and dead, which is terminal.

### Signature with secret rotation

Each delivery carries the `Araute-Signature` header in the format `t=<timestamp>,v1=<signature>`. The signature is an HMAC-SHA256 over `timestamp.body`, where the body is the exact bytes sent. The consumer rejects timestamps more than 300 seconds off from their clock, which protects against replay, and compares in constant time.

When the secret is rotated, the old one stays valid for 24 hours and the header carries two `v1` signatures. The consumer accepts if either matches. The merchant rotates the secret at their own pace, with no downtime window.

### Retries with jitter

Up to 12 attempts over about three days, with growing intervals and a random variation of up to 20% on each. The jitter prevents many deliveries that failed in the same minute, such as at a month rollover with lots of subscription renewals, from all coming back at the same instant. Any non-2xx response counts as a failure, including a redirect, because I don't follow 3xx. The wait for a response is 10 seconds.

Once the schedule is exhausted, the delivery becomes dead. It's never reopened: resending an event creates a new delivery, and the old one's history stays intact. An endpoint with a dead delivery for seven days and no success in the period is deactivated automatically.

### The contract with the consumer

The envelope carries the event `id`, the type, the API version and a snapshot of the object at commit time. The [public documentation](https://docs.araute.com/comece-aqui/webhooks) tells the merchant to deduplicate by `id`, not to rely on ordering, and to query the API when the decision is critical.

## An example

The difference between a naive dispatch and a post-commit one fits in a few lines. First, the way that produces the phantom event:

```ts
await db.transaction(async (trx) => {
  await trx.updateTable('payments').set({ status: 'succeeded' }).where('id', '=', id).execute()
  await notifyMerchant(id) // already left the building
  await ledger.post(trx, id) // throws: the transaction rolls back, the webhook does not
})
```

Then, with the outbox and scheduling after commit:

```ts
await db.transaction(async (trx) => {
  await trx.updateTable('payments').set({ status: 'succeeded' }).where('id', '=', id).execute()
  const eventId = await trx.insertInto('outbox_events').values(snapshotOf(id)).returning('id').execute()
  await ledger.post(trx, id)
  // scheduled only if the commit succeeds; dropped on rollback
  afterCommit(() => queue.send({ eventId }))
})
```

And here's how the schedule looks for a delivery to an endpoint that was down for a few hours:

| Attempt | Approximate time | Response | State |
| --- | --- | --- | --- |
| 1 | 10:15 am | timeout | failed |
| 2 | 10:16 am | 503 | failed |
| 3 | 10:21 am | 503 | failed |
| 4 | 10:51 am | 301 | failed (redirect isn't followed) |
| 5 | 11:53 am | 200 | success |

## Result

Every delivered event corresponds to a state stored in the database. The merchant can rotate the secret without stopping the integration, recover from an unavailability window with a resend, and deduplicate with a stable identifier. On the operations side, the retry backlog and dead deliveries become metrics with alerts, which allows acting before the schedule runs out.

## What I take from it

The outbox in the same transaction costs one table and one consumer, and eliminates a whole class of inconsistency. I'd do it again even in a small system. The other lesson is to write the contract thinking of the consumer who will make mistakes: deduplication by `id`, no ordering guarantee and "query the API before deciding" need to be in the documentation, not just in my head.
