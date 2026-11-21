---
title: "Reconciling the Pix statement without the safety net becoming a second path"
summary: "When a Pix notification is lost, the money is in the account but the charge stays open for the merchant. I built statement reconciliation to recover those payments without crediting anything twice and to send doubtful cases to a person."
project: araute
order: 7
tags: [Reconciliation, Webhooks, Idempotency, Ledger, Pix]
---

Picture a night when the endpoint that receives notifications from the Pix provider (Pix is Brazil's instant payment system) is down for longer than the provider keeps retrying. A buyer paid a Pix at 11:58 pm. The money is in the account, but the notification never arrived, and the charge still shows "awaiting payment" on the merchant's dashboard. Someone has to notice this without depending on a human opening the statement.

## The problem

The webhook is the normal way to know a payment happened. It's cheap and fast, but it fails. If the endpoint is down beyond the provider's retry window, the event is lost. A Pix sent straight to the key, with no associated charge, arrives with no correlation at all.

I had to guarantee both directions: all money that exists at the provider has a mirror in Araute, and all money Araute believes it has exists at the provider.

## Why it wasn't trivial

The biggest risk of a reconciliation is that it becomes a second write path, with its own rules, that gradually diverges from the first. Then it credits again what the webhook already credited, or reduces the merchant's balance because it interpreted a delay as an absence.

There's also the day rollover. A hard cut at midnight loses exactly the 11:58 pm Pix that the provider recorded at 12:01 am.

And not every match between statement and charge is reliable. Two R$ 50.00 payments in the same minute are indistinguishable if the only clue is the amount.

## The solution

### Same apply, not a parallel path

Reconciliation has no write logic of its own. It turns what it finds in the statement into an internal event, in the same format the webhook produces, and hands that event to the same code: same normalization, same state machine guards, same idempotency. Deduplication uses the Pix end-to-end identifier (the end-to-end ID, which the Central Bank assigns to each transaction) and the deterministic key of the accounting entry.

When reconciliation finds a payment the webhook already processed, the result is a no-op. That's what makes it safe to run often and over overlapping windows.

### Window with overlap

The base window is the previous day, closed, but the query to the provider extends the edges by a few hours on each side. A border item shows up in two runs, and the second does nothing. I'd rather reprocess than lose.

### Matching from strongest to weakest

For each statement item, I try to match it against a charge in this order and stop at the first hit:

1. end-to-end ID of the Pix settlement
2. dynamic QR identifier
3. the correlation identifier I sent myself, when the provider returns it
4. amount plus a short time window

The fourth criterion is ambiguous by nature. That's why it never triggers a financial effect on its own: the item goes to human review, flagged as weak confidence. The key that produced the match is stored, because knowing how something was reconciled matters as much as knowing that it was.

### Each discrepancy is a record

A discrepancy doesn't silently fix anything. Each item becomes an auditable record with a type: paid at the provider with no mirror in Araute, paid in Araute with no confirmation at the provider, different amount, unmirrored chargeback, duplicate.

### What gets automated and what needs a human

The line is simple. I only automate what adds money provably present at the provider and is idempotent, like synthesizing the event of a payment whose webhook was lost. Anything that would reduce the merchant's money based on the absence of something requires a human. The exception is an irrevocable fact already in the statement, like a refund executed at the provider itself: there the money has already left.

There's also a safety limit. If a run were about to recover items above a threshold, it pauses and alerts instead of applying in bulk. A bug in the reconciler can't "recover" the whole world in one night.

## An example

The 11:58 pm Pix, on a timeline:

```txt
23:58:10  buyer pays R$ 50.00; the provider settles (e2e E1234...)
23:58:11  provider tries the webhook: endpoint down
00:40     provider exhausts retries; the event now only exists in the statement
03:00     reconciliation queries the previous day, from 22:00 to 02:00
03:00     item E1234 matches charge ch_789 by key 1
03:00     synthetic "payment confirmed" event enters the same apply
03:00     state machine: awaiting -> paid; journal posted
03:00     merchant receives the payment confirmed webhook
03:00+1d  next run sees E1234 again in the overlap: no-op
```

The heart of it is that webhook and reconciliation call the same function:

```ts
type ProviderFact = { e2eId: string; amountCents: number; paidAt: string }

async function onWebhook(raw: ProviderPayload) {
  await applyPayment(normalize(raw))
}

async function onReconciliationItem(item: StatementItem) {
  const match = await matchStrongest(item)
  if (match.confidence === 'weak') return openReview(item, match)
  await applyPayment({ e2eId: item.e2eId, amountCents: item.amountCents, paidAt: item.paidAt })
}

async function applyPayment(fact: ProviderFact) {
  // dedupe by e2eId makes the second call a no-op, wherever it comes from
  if (await alreadyApplied(fact.e2eId)) return
  // ...state transition, accounting entry and event to the merchant
}
```

## Result

The webhook remains the main, low-latency path, and reconciliation is the safety net that closes the gaps. Because both reach the same code, there's no rule that holds in one and not the other. And because the ledger is immutable, every correction leaves a trail: a reconciliation record, an internal event and, once resolved, a new entry.

## What I take from it

When there's a main path and a safety net, both have to flow into the same application code. Two write paths always diverge, you just don't know when.
