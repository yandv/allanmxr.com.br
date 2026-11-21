---
title: Payment state only changes through a pure function that returns effects
summary: "Cancellation, bank confirmation and expiration can reach the same payment in the same second and, if each path decides on its own, the money ends up on a cancelled charge. I centralized every state change in a single tested rule that no path can bypass."
project: araute
order: 4
tags: [State machines, TypeScript, Domain-Driven Design, Zod, OpenAPI]
---

A Pix payment (Brazil's instant payment system) is processing. In the same second, three things happen: the merchant calls the API to cancel, the provider's webhook says the money landed, and the Cron that expires old payments passes by. Three concurrent writes on the same record, each with its own idea of what should happen. If each path decides on its own, the final state is that of whoever wrote last, and the buyer's money can end up on a charge marked as cancelled.

## The problem

Araute has several objects with their own lifecycle: the PaymentIntent (the intent to charge an amount, which goes through several payment attempts until it's paid or cancelled), the charge, the payment attempt, the subscription, the refund, the dispute, the fiscal document, the payout, among others. State changes come from four origins: the merchant's API, the provider's webhook, the scheduled jobs and reconciliation.

Without a single rule, each origin ends up reimplementing a piece of the logic, and the versions diverge. A race bug, in a payments platform, becomes money in the wrong place.

## Why it wasn't trivial

The hard part isn't the happy path. It's what can't happen.

An already paid payment can't go back to "awaiting payment method". An expired PaymentIntent that receives money later doesn't become "paid", because Pix settlement is irrevocable and that's an anomaly for reconciliation to handle, not an ordinary transition. A PaymentIntent in processing can't be cancelled through the API, because the money may be settling at that very instant.

These rules have to hold equally for the four origins and must be testable without spinning up a database, a queue or a clock mock.

## The solution

### Rule on paper first, then in code

For each object, I wrote the state machine as canonical documentation: diagram, transition table, terminal states and the list of the most dangerous forbidden transitions, each with its reason. Only then did it become code.

### One signature for all transitions

Every transition, for any object, has the same shape: it receives the current state and an event and returns a result. The result is either success, with the next state and a list of effects, or a typed error, of one of three kinds: illegal transition, failed guard or no-op replay.

The function is pure. Everything it needs to know (the instant, the IDs, the settled amounts) arrives inside the event, assembled by the outer layer. There's no parallel context object. That allows testing by data equality, without mocks.

### Effects as data

The function does no I/O. Instead of emitting the event or posting to the ledger, it returns a list of effects described as data: emit a domain event, invalidate a cache, post an accounting journal, enqueue an invoice. The service layer runs that list, inside the database transaction. Effects that depend on a commit, like enqueuing webhooks, only run after it.

### Two errors worth attention

The no-op replay is the idempotent case: the event was already applied, and the outer layer treats it as a silent success. It's what lets the duplicate webhook and reconciliation run over an already processed payment without breaking anything.

The illegal transition carries a stable code, like `payment_intent_unexpected_state`. When the cause is an API call, that code becomes the error response in the Problem Details format of RFC 7807, and the integrator can branch on it.

### Out of order is discarded, not repaired

An event that arrives in the wrong state becomes a no-op replay or an error. It never becomes an UPDATE to "fix" the state.

### Status from a single source

Each status family is a constant object in TypeScript with the type derived from it. The same object feeds the API's Zod schema and the column's CHECK constraint in PostgreSQL. The OpenAPI contract is generated from the Zod schemas, and the dashboards generate their types from the contract. A new status is born in one place and reaches everyone through the contract, or the build breaks.

## An example

A slice of the PaymentIntent machine, with simplified names, shows the shape:

```ts
type Result<S> =
  | { next: S; effects: Effect[] }
  | { kind: 'illegal' | 'guard_failed' | 'noop_replay'; code: string; from: S }

function transitionIntent(current: IntentStatus, event: IntentEvent): Result<IntentStatus> {
  switch (event.type) {
    case 'payment_confirmed':
      // a duplicate webhook or a reconciliation pass lands here: success, no side effects
      if (current === 'succeeded') return noop(current)
      if (current !== 'processing') return illegal('payment_intent_unexpected_state', current)
      return { next: 'succeeded', effects: [emit('payment_intent.succeeded'), bumpCache('intents')] }

    case 'cancel':
      // money may be settling while processing, so only pre-network states can cancel
      if (current === 'processing' || current === 'succeeded') {
        return illegal('payment_intent_unexpected_state', current)
      }
      return { next: 'cancelled', effects: [emit('payment_intent.cancelled')] }
  }
}
```

And the test becomes an input and output table, with no database:

| Current state | Event | Result |
| --- | --- | --- |
| processing | payment_confirmed | succeeded, emits `payment_intent.succeeded` |
| succeeded | payment_confirmed | no-op replay |
| requires_payment_method | payment_confirmed | illegal, `payment_intent_unexpected_state` |
| processing | cancel | illegal, `payment_intent_unexpected_state` |
| requires_action | cancel | cancelled, emits `payment_intent.cancelled` |

Back to the opening scene: the merchant's cancellation gets a clear error, the webhook confirms the payment, and the expiration Cron, if it arrives later, is refused by the guard, because it only expires what's still waiting for payment. The paid state doesn't move.

## Result

The state machine became the only door for changing state, and the most dangerous rules are written down as prohibitions with reasons, in the document and in the code. Transition tests are fast tables, with no infrastructure. And describing effects as data made one guarantee that seemed separate easier: no background work survives a rollback, because the layer that runs the effects knows which ones depend on the commit.

## What I take from it

Separate deciding from executing. A pure function that returns the next state and the list of effects is easy to test, easy to read in code review and hard to misuse. And writing the forbidden transitions before the allowed ones changes the design's focus: the happy path writes itself, what needs attention is what can never happen.
