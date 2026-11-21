---
title: Paying by card an invoice that already has a boleto issued
summary: "Stripe won't let an invoice with an issued boleto be paid by card, and the customer would be left waiting for the boleto to expire. I created a flow that swaps the invoice safely, with no risk of charging twice if the boleto is paid later."
project: great-softwares
order: 12
tags: [Stripe, Boleto, Payments, Saga, Idempotency]
---

Imagine a Great Apps customer who receives the monthly boleto (a Brazilian bank slip), puts it off and, on the due date, decides they'd rather pay by card. They go into the dashboard, register the card and click "pay invoice". If the system just passed the request on to Stripe, the response would be a message saying there is a pending boleto. They would have no way out: they would have to wait for the boleto to expire and for Stripe to change the status, which takes longer than the due date itself. In the meantime, the account could go overdue.

## The problem

When Stripe issues a boleto, it creates a PaymentIntent (the object that represents the charge attempt) in the `requires_action` state, waiting for payment at the bank. In that state, Stripe rejects every obvious shortcut:

- paying the invoice by card fails, because the boleto's PaymentIntent can't be edited or canceled;
- marking it paid out of band is refused while an open payment exists;
- attaching a separate card PaymentIntent charges the card, but doesn't settle the invoice.

The paths the app had ran into this restriction: one route switched the subscription to card without charging anything and returned the pending boleto message, the other simply refused. Neither solved what the customer wanted.

## Why it wasn't trivial

The issued boleto remains payable at the bank until it expires, even if I void the invoice in Stripe. And Stripe has no refunds for boletos. That creates a dangerous window: if I charge the card, void the invoice and the customer still pays the boleto, they paid twice, and returning money on either side becomes a manual process.

On top of that, any sequence of calls can stop halfway. A Worker shut down, a slow Stripe, a delayed webhook, a card asking for 3DS (the issuing bank's extra authentication challenge). And the subscription itself couldn't change payment method because of this: the customer wanted to pay this cycle by card, not migrate permanently.

## The solution

Instead of forcing the original invoice (I'll call it A), I created an invoice B: a replacement, standalone, card-only, with the same lines and the same periods as A, so the tax invoice comes out in the right competence period. B is tied to the subscription by metadata, not by the native link. An invoice with the native link would drag in the subscription's pending items and could become its "latest invoice", entering the dunning process.

### The three rules

1. **Charge first, void afterwards.** If the card is declined, the cycle's debt still exists in A, intact.
2. **Never void without proof.** Every decision comes from a state re-read from Stripe with no cache, never from the response of a previous write.
3. **Never treat the cycle as paid before A is confirmed voided.** Until then, B doesn't exist for the rest of the system.

### States in metadata

B is born hidden from listings, affiliate commission, the tax invoice and integrations. Its state advances on a metadata key: `pending` (created, A not yet voided), `settled` (A confirmed voided and local subscription reconciled) and `done` (the payment effects ran at least once). There's an emergency exit, `refunding` and `refunded`, for when the card was charged but A couldn't be voided: I refund the card and clear the marks.

Keeping the state on Stripe's own invoice was deliberate. The reconciler finds the replacements through Stripe's metadata search and doesn't depend on a table of mine being in sync.

### An inheritance trap

B doesn't receive the marks that identify a standalone cycle invoice. Those marks authorize a cron job that cancels for overdue payment. If B inherited them, the system could cancel the subscription because of an invoice that exists only as a bridge.

### The reconciler

A cron job every 10 minutes resumes whatever was left half done:

- B open and `pending` for more than an hour (abandoned 3DS): voids B;
- B paid and `pending` for more than 15 minutes: finishes the closing;
- `refunding` stalled: resumes the refund;
- `settled` that never reached `done`: reruns the payment effects, at most three times, with a minimum interval between them.

Its manual trigger starts in simulation mode, and only runs for real in a test environment.

## An example

The closing, after B has been paid, in TypeScript with generic names:

```ts
async function settleReplacement(b: Invoice) {
  const a = await stripe.invoices.retrieve(b.metadata.replaces_invoice); // no cache
  if (a.status === "open") {
    await stripe.invoices.voidInvoice(a.id);
  }
  // rule 2: decide by what Stripe says now, not by the void's return value
  const fresh = await stripe.invoices.retrieve(a.id);
  if (fresh.status === "paid") return startRefund(b, "original_paid_first");
  if (fresh.status !== "void") return scheduleRetry(b);

  await reconcileLocalSubscription(b.metadata.subscription);
  await stripe.invoices.update(b.id, {
    metadata: { replacement_state: "settled", skip_in_listing: "" },
  });
}
```

And three possible outcomes for the same click:

| Scenario | Sequence | Result |
|---|---|---|
| Happy path | creates B, charges card, re-reads A open, voids A, re-reads A voided, reveals B | cycle paid by card, boleto ignored |
| Card declined | creates B, charge fails, voids B | A remains open with the boleto, nothing changed for the customer |
| Boleto paid in the middle | creates B, charges card, re-reads A and finds A paid | B goes to `refunding`, card refunded, cycle paid by boleto |

The third scenario is the reason for rule 2. If I trusted the response of the void command, I could mark the cycle as paid by card while the bank had already settled the boleto.

## Result

The customer can pay by card for a cycle that already had a boleto, without changing the subscription's payment method and without depending on Stripe releasing the PaymentIntent. Interruptions halfway are resumed by the reconciler, and each relevant state generates its own log event.

Before writing the flow, I measured on Stripe's test environment every behavior it depends on: voiding A with a live boleto, what arrives when the boleto is paid after the void, how idempotency responds to two simultaneous charges, how long metadata search takes to see a new invoice. The design came from those measurements, not from assumptions.

One risk was knowingly accepted: if the customer pays the boleto and the card almost at the same time, they end up with both charges until the reconciler refunds the card, which takes a few minutes.

## What I take from it

When an external system doesn't let you undo a step, the way out is to model the operation with two objects and a strict order: the reversible step first, the irreversible one last, and never advance without re-reading the real state.

Keeping the saga's state on the external object itself, in metadata, makes resumption simple. The cron job doesn't need to trust a local copy. And measuring the API before designing on top of it saves weeks of fixes.
