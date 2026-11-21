---
title: Professional payouts in batches, with the rule frozen on the charge
summary: "A clinic pays each professional for what they attended, with rules that change over time and a Pix that can't be undone. I designed payouts to freeze the rule on every charged line and to pay in batches that check the balance up front and fail per professional, not for the whole batch."
project: salte
order: 2
tags: [Finance, Professional payouts, Pix, PostgreSQL, ERP]
---

It's the end of the month at a clinic with eight professionals. The manager opens the payout closing: how much each one is owed for the appointments and procedures they performed and that patients have already paid for. A dermatologist earns 40% of appointments; a physiotherapist earns a fixed amount per session; one rule was renegotiated on the 15th. The manager reviews it, enters the PIN and submits. Eight Pix transfers (Brazil's instant payment system) leave the clinic's account. If one of them fails, the other seven can't be left waiting, and none can go out twice.

## The problem

A professional payout is the share of the clinic's revenue that goes to the professional who performed the service. It looks like simple math, percentage times amount, but there are three hard questions behind it: which rule to calculate with, when the amount starts to count, and how to pay a group of people at once with a payment method that has no undo.

Payout rules change. If the calculation were redone at closing time with the rule in force, a renegotiation in the middle of the month would rewrite the past. And the payment goes out by Pix from the clinic's account: a transfer that has been sent doesn't come back through a database rollback.

## Why it wasn't trivial

The rule comes in two kinds: a percentage of the line amount or a fixed amount per unit. It can belong to the professional for that service or be the clinic's default for the service, and a professional can have their own price without having their own rule.

The amount only counts when the money comes in. An appointment done on the 30th and paid on the 2nd belongs to the next month. And a professional can transfer part of their balance to a colleague, so "how much can they receive" isn't just the sum of their appointments.

At payment time, each professional needs a default Pix key, the clinic's account needs enough balance, and the send can end without a clear answer from the bank. All of that, for several professionals, in the same click.

## The solution

### The rule is frozen on the charge line

When the charge is created, each line stores a snapshot of the rule: type, value, the professional who performed the service and the payout amount already calculated. The percentage is stored in basis points (10,000 is 100%), so everything works with integers. The closing only sums what is stored and never recalculates. Renegotiating a rule applies from then on, by design.

The winning rule follows an order: the professional's rule for that service, if it has a value; otherwise, the clinic's default rule for the service; otherwise, no payout. A stored zero counts as "no rule", to avoid generating R$ 0.00 lines. The base is the gross line amount: a discount granted to the patient on the charge doesn't reduce the payout.

Selling a session package generates a zero payout on the day of the sale. Each delivered session freezes its own payout for whoever actually performed it.

### Only what has been paid counts

The realized balance only looks at paid charges, by payment date. A separate view shows the expected amount, with what is still to be received, without mixing the two on the closing screen.

### The batch reserves the lines

Each payout in a batch links the charge lines it is paying. A partial unique index guarantees that a line belongs to at most one active payout: two simultaneous closings don't pay the same appointment, and the second one gets a conflict. Each professional's available balance (realized, minus what was already paid, minus what was transferred to colleagues, plus what was received) is computed under a per-professional lock.

### Paying without a giant transaction

Before creating anything, the batch runs a simulation and checks whether the clinic's account has enough balance for the total. If it doesn't, the whole batch is rejected up front, with no Pix sent.

After that, each professional is paid in short, separate transactions, on purpose: gather the lines, check the default key and the balance, record the Pix attempt before sending, send and mark as paid. A single transaction for the batch would be a lie, because a sent Pix doesn't come back on a rollback.

The batch is written as "processing" before the first send, so an interruption shows up as an interruption, never as a false "paid". In the end, it finishes as paid, partial or failed.

### Per-professional failures, with a reason

A payout that doesn't go out stays pending with a readable reason: professional without a Pix key, batch budget exhausted, key rejected by the bank, account Pix limit reached or unknown result. Insufficient balance for the send stops the ones still in the queue, but all of them show up with the reason. A professional without a key is left out of the balance calculation, so they don't block their colleagues.

"Retry" only exists for partial or failed batches. It first asks the bank about the outcome of any send with an unknown result; then it cancels and regroups, now including what the professional earned in the meantime.

### A Pix returned later

If a payout Pix comes back after it was settled, the payout becomes reversed, a compensating revenue entry is posted on the date of the original expense and the lines are released for the next batch. That way, a July payout returned in August doesn't distort July.

## An example

Fictional amounts, real formulas:

| Line | Price | Winning rule | Payout |
| --- | --- | --- | --- |
| Ana's appointment | R$ 300.00 | Ana's: 40% (4,000 basis points) | R$ 120.00 |
| Ana's procedure, 2 units | R$ 80.00 each | clinic default: R$ 25.00 per unit | R$ 50.00 |
| Bruno's appointment | R$ 333.33 | Bruno's: 35% | R$ 116.67 |

Ana's appointment had a R$ 30.00 discount for the patient, who paid R$ 270.00. The payout is still R$ 120.00, because the base is gross.

```ts
type Rule = { kind: 'PERCENT' | 'FIXED'; value: number }; // PERCENT in basis points

function payoutCents(lineTotalCents: number, quantity: number, rule: Rule): number {
  if (rule.kind === 'FIXED') return rule.value * quantity;
  return Math.round((lineTotalCents * rule.value) / 10_000); // 33333 * 3500 / 10000 = 11666.55 -> 11667
}
```

At closing, the total is R$ 170.00 for Ana and R$ 116.67 for Bruno, R$ 286.67 for the batch. With R$ 200.00 in the account, the batch is rejected before any send. If Bruno had no Pix key, the required total would be R$ 170.00: the batch would go out, finish as partial, and Bruno's payout would stay pending with "The professional has no registered PIX key", waiting for the next "retry".

## Result

The month-end closing is a sum of frozen numbers, checkable line by line, and a renegotiated rule doesn't rewrite the past. A batch never starts without balance, never pays the same appointment twice and, when something fails, it fails for one professional, with a reason, without holding up the others. Payment requires the permission to manage finances and the PIN of whoever executes it, and the name of whoever confirmed is recorded on the batch.

## What I take from it

With money, the number that matters is the one from the moment the obligation was born, not the one from the moment someone looks at it. Freezing at the origin simplifies everything afterwards. And when a step has no undo, like a Pix, the right transaction is a small one: one per irreversible effect, with the state written before acting.
