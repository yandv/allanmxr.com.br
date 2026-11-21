---
title: A provider webhook is a trigger, not proof of payment
summary: "A payment webhook can arrive repeated, out of order, forged, or not arrive at all, and applying it directly can credit the merchant twice. I store every notification and verify it before touching the balance, without losing any event."
project: araute
order: 2
tags: [Webhooks, HMAC, Hono, Cloudflare Queues, Pix]
---

A buyer pays an R$ 89.90 Pix (Brazil's instant payment system) at 2:02 pm. A few seconds after 2:02, the Pix provider notifies Araute by webhook. At 2:03 the same notice arrives again, because the first response was slow. At 2:05, an expiration notice for the same charge arrives, which had been sitting in the provider's queue since before the payment. If I apply each notice as it comes, the merchant gets two credits and then sees the charge marked as expired.

## The problem

The webhook is the cheapest and fastest way to know a payment happened. But it isn't reliable as a source of truth. It can arrive duplicated, out of order, after a period when my endpoint was down, or it may not even have come from the provider. Applying what arrives opens the door to duplicate credits, state regressions and someone forging a payment.

## Why it wasn't trivial

Some providers' retry window is short, a few dozen minutes. After that, the event only exists in the provider's dashboard. So I can't afford to lose an event that arrived.

At the same time, signature schemes vary a lot from provider to provider, and not all of them protect against replay with a timestamp. The signature alone isn't enough to trust the content.

And there's a detail that silently breaks validation. An HMAC (an authentication code computed with a shared secret over the message) only matches if it's computed over exactly the same bytes the provider signed. If the framework parses the JSON and I reserialize it to validate, one fewer space or a different key order is enough for the signature to never match again.

## The solution

The inbound route is linear, and each step exists for a reason.

### Raw body first

In Hono, I read the body as text, before any parse. The event is stored immutably, along with the received headers, still uninterpreted. That raw record gives me internal replay without depending on the provider and lets the adapter evolve without losing old events: if I fix the parser tomorrow, I can reprocess what arrived yesterday.

### Signature over the bytes

With the event saved, I validate the signature over the exact text received. If it doesn't match, I mark the event invalid, don't process it and raise an alert. The response to the provider is still 2xx: answering 4xx would only make the sender resend possibly forged content, and that helps nobody.

### Respond fast, process on the queue

The route responds 2xx within a few milliseconds and enqueues only the event ID on Cloudflare Queues. The heavy work stays with the queue consumer, outside the provider's response time.

### The core never reads the raw status

Each provider has an adapter that translates its payload into an internal event in my own vocabulary, such as "payment confirmed" or "payment expired". Only that internal event reaches the state machine. For events that move money, the adapter also queries the current state from the provider's API before applying. If the API disagrees with the webhook, the API wins. The webhook is a trigger, not proof.

### Out of order is discarded by the guard

The state machine receives the current state and the event and decides. An expiration that arrives after the charge is already paid is refused, instead of becoming an UPDATE. The event is marked as ignored and the paid state never regresses.

### Dedupe at the entry, idempotency in the application

A uniqueness constraint on provider and event ID blocks the same raw event twice. When the provider doesn't send a stable ID, I use the end-to-end Pix settlement identifier, the E2E ID that the Central Bank assigns to each transaction. But I treat that dedupe only as an optimization. The guarantee of applying once lives in the application's idempotency: even if two events for the same fact slip through the filter, the effect doesn't repeat.

### Safety net

The event that never arrived isn't this route's problem. It's left to periodic reconciliation against the provider's statement.

## An example

The core of the route, simplified, looks like this. The order of the lines is the design decision.

```ts
app.post('/hooks/:provider', async (c) => {
  // read bytes before any JSON parse: the signature covers this exact text
  const rawBody = await c.req.text()
  const headers = Object.fromEntries(c.req.raw.headers)

  // persist first, so an event that arrived is never lost
  const event = await events.insertIfNew({ provider: c.req.param('provider'), rawBody, headers })
  if (!event) return c.body(null, 200) // duplicate, already stored

  if (!verifySignature(rawBody, headers, secretFor(event.provider))) {
    await events.markInvalid(event.id)
    alert('inbound_signature_invalid', { provider: event.provider })
    return c.body(null, 200) // a 4xx would only invite a resend
  }

  await queue.send({ eventId: event.id })
  return c.body(null, 200)
})
```

And the opening scene's timeline going through this flow:

| Moment | Arrives | What happens |
| --- | --- | --- |
| 2:02:05 pm | payment confirmed | saved, signature valid, enqueued; the consumer queries the provider, confirms and applies: charge paid |
| 2:03:10 pm | the same notice again | blocked by the event uniqueness, responds 200 |
| 2:05:00 pm | late expiration | saved and enqueued; the state machine sees "paid + expire", refuses the transition and the event is marked as ignored |
| 2:20:00 pm | nothing | the reconciliation Cron goes over the charge, it's already paid, nothing changes |

## Result

A consumer error doesn't go back to the provider, because the 2xx has already gone out. It stays on the queue with retries and, once attempts are exhausted, goes to a dead-letter queue with an alert, while the raw event remains in the database for manual reprocessing. The system doesn't lose an event that arrived and has a recovery path for the one that didn't.

## What I take from it

Persist before interpreting. The raw body is the only faithful record of what happened, and everything I derive from it can be redone. The second lesson is to treat a notification as a trigger: it tells me when to look, but what says what happened is the source I query and the state machine that receives the fact.
