---
title: "Pix Automático between two providers: webhook, timeout and cleanup fighting over the same signup"
summary: "The Pix Automático confirmation arrives repeated, out of order and sometimes after the customer has given up, which could duplicate the subscription or lose the payment. I made the flow withstand that and a daily audit flag whatever slips through."
project: great-softwares
order: 11
tags: [Pix Automático, Stripe, Idempotency, Saga, Webhooks]
---

Imagine a customer who chooses to pay for her Great Apps subscription with Pix Automático (Pix recurring debit, on Brazil's instant payment system). She scans the QR code, opens her bank app and authorizes. Meanwhile, on the Great Apps screen, she gets tired of waiting and clicks "back". Ten seconds later, the Pix provider sends the webhook saying she authorized. Two seconds later, it sends it again. The system has to decide, with no human help, whether to create the subscription, whether to create it only once and what to do if the authorization arrives after the screen has already given up.

## The problem

Pix Automático works with a mandate: an authorization the customer gives in the bank app so a payee can debit recurring amounts, within a ceiling, without a new confirmation each cycle. In Great Apps, the mandate lives at the Pix provider, but the subscription and the invoices remain in Stripe, which is the source of truth for billing. Money that comes in through Pix is reconciled in Stripe as paid out of band.

There are three states that must agree: the mandate at the Pix provider, the subscription in Stripe and a local row that tracks the signup. What announces that the customer authorized is a webhook, and a webhook can arrive duplicated, late, out of order or after the customer gave up.

## Why it wasn't trivial

Each system fails on its own. If the commit (the step that creates the subscription in Stripe) dies halfway, I can end up with money debited and no subscription, or with a subscription created on top of a revoked mandate. There is no transaction that spans the Pix provider, Stripe and my database at once.

There was also a not-so-obvious value rule. The Pix provider only treats the mandate as variable-value if the minimum value is strictly less than the mandate's value. If they're equal, the variable-value field is ignored and I lose the ability to adjust the value later. That matters when there's a discount on the first cycle: the customer authorizes the ceiling of the full value, pays the first month with the discount, and the mandate's value can only go up to the recurring amount after that first invoice is paid.

And three different processes fight over the same row: the webhook that wants to do the commit, the timeout that wants to abandon the signup and a periodic cleanup that clears whatever was left idle.

## The solution

### One row with explicit phases

Each signup or payment method change becomes a row with a phase: `creating`, `awaiting_authorization`, `committing`, `completed`, and the exits `expired`, `rejected` and `manual_review`. Every phase change is a compare-and-set: an `UPDATE` that only happens if the current phase is still the one I read. If the `UPDATE` affects no row, another process got there first, and I leave with no side effect.

### Commit lease

Only whoever manages to move the row to `committing` creates the subscription. That phase carries the time at which it was claimed. If the commit throws, I explicitly mark the lease as released, so the next webhook delivery can resume. If the worker dies, the lease expires on its own after ten minutes. The timeout and the cleanup respect the same condition, so nobody expires a row while it's being committed.

### A payment on a closed row doesn't vanish

If a payment arrives on a row that's already expired or rejected, I don't discard it. I return a failure to the webhook, the event is parked and enters reconciliation. Money received always has a traceable destination.

### Effects before closing

Notices to other products, such as activating a domain bought together, are enqueued before the row becomes `completed`. If enqueueing fails, the whole commit repeats. If I closed the row first, a failure there would lose the event forever.

### A daily auditor

A cron job audits every day the active Pix Automático subscriptions against the mandate's state: divergent value, canceled mandate with an active subscription, debit with no matching invoice. To respect the provider's call limit, it splits the set into deterministic slices by day: each run looks at one slice, and the full cycle covers everyone. It was born in simulation mode, applying a status fix only when a configuration said so. After the main flow matured, I took away its power to write to the provider: today it audits and alerts the billing operation, and the normal flow does the fixing.

## An example

The heart of it is the conditional transition. In TypeScript, with generic names:

```ts
const LEASE_MS = 10 * 60 * 1000;

async function claimCommit(row: PendingRow): Promise<boolean> {
  const s = row.state;
  const leaseFree =
    s.phase !== "committing" ||
    s.leaseReleasedAt != null ||
    Date.now() - Date.parse(s.committingAt) > LEASE_MS;
  if (!["awaiting_authorization", "committing"].includes(s.phase) || !leaseFree) return false;

  // the WHERE repeats what I read: if someone changed the row in the meantime, nothing is updated
  const updated = await db.updateWhere(
    { id: row.id, phase: s.phase, committingAt: s.committingAt ?? null },
    { phase: "committing", committingAt: new Date().toISOString(), leaseReleasedAt: null },
  );
  return updated === 1;
}
```

And a timeline with the customer from the opening:

| Time | Event | What happens to the row |
|---|---|---|
| t=0 | QR code generated | phase `awaiting_authorization` |
| t=40s | customer closes the screen | nothing changes; the row only expires on timeout |
| t=52s | authorization webhook (delivery 1) | claim wins, phase `committing` |
| t=54s | authorization webhook (delivery 2) | claim loses (lease taken), responds "try later" |
| t=55s | subscription created in Stripe, notice enqueued | phase `completed` |
| t=2min | redelivery 2 | reads `completed`, ends with no effect |
| t=30min | timeout tries to expire | compare-and-set fails, the row is already completed |

If the worker had died at t=54s, the redelivery after ten minutes would find the lease expired and would finish the commit.

## Result

The flow withstands duplicate, late and out-of-order delivery without creating a double subscription and without losing a payment. The races between webhook, timeout and cleanup are resolved in the database, not in assumptions about the order of events. The daily auditor catches what slips through, such as a value divergence in the mandate, and alerts the operation before it becomes a complaint.

## What I take from it

In a saga across external systems, trying to predict every arrival order of the webhooks is a lost battle. A state row with compare-and-set per phase and a lease with an expiry solve most cases without my having to enumerate them.

And an auditor that starts out only observing is the cheapest way to discover the cases I didn't think of. Giving it write power is a separate decision, and in my case the right decision was to take that power away later.
