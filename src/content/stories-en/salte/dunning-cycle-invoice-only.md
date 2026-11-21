---
title: "Dunning: only the cycle invoice moves the subscription"
summary: "A dunning process needs to know which invoices can put the clinic past due, when the grace period starts counting, and how to add up payments that arrive together. I designed those three rules and tied them to end-to-end tests."
project: salte
order: 12
tags: [Billing, Dunning, PostgreSQL, Concurrency, Subscriptions]
---

A clinic that is up to date on the monthly plan decides to buy an extra credit pack, and the card declines that one-off purchase over the limit. The monthly fee is paid. What failed was an R$ 89.00 purchase that she can try again with another card. What should dunning do with that decline? Nothing to the subscription, of course. But "of course" only holds if the rule is written in the code and covered by a test.

## The problem

The platform's billing has a dunning process, the process that reacts to failed payments. On cards, it retries the charge at intervals of 1, 2, 4, 5, and 7 days. The subscription goes past due, gets seven days of grace, becomes delinquent, and fifteen days later is canceled for nonpayment.

As billing gained one-off purchases, top-ups, extra modules, and the 3D Secure flow, three questions that the first version of dunning answered implicitly needed an explicit answer:

- Which declined invoice can move the subscription to past due? The initial version only checked whether the invoice had a subscription, which would include one-off purchases, top-ups, and extra module proration.
- When does the grace period start counting? Counting from the end of the cycle gives a charge that fails later fewer days than the rule promises.
- How do you add up the amount paid when webhook, retry, and reconciliation settle the same invoice at the same time? Reading, summing in the application, and writing back loses updates.

I reviewed all three in the same round, with tests covering each combination.

## Why it wasn't trivial

Each rule has a small implementation, but all three touch the heart of billing, where a mistake becomes an undue charge or an undue cancellation. Dunning also has different paths per payment method, and the card authentication case (3D Secure) uses the same past-due entry to make the clock run. A rule that looked only at the declined card would leave that path inconsistent.

And there were subscriptions created before the new time marker existed, which had to keep working without a migration.

## The solution

### Only the cycle invoice moves the subscription

The right question is "does paying this invoice take the subscription out of past due?". Only the recurring cycle invoice answers yes. A declined one-off purchase stays open to be paid from the invoices screen, without touching the subscription state and without entering dunning. The same rule applies to the 3D Secure path: required authentication on a one-off purchase does not put the subscription past due.

The retry without the customer is also restricted to the cycle invoice. A one-off invoice is never retried automatically: the person decides whether to pay.

### Grace anchored at the moment of becoming past due

The subscription gained a field with the instant it went past due, written on entry and cleared on exit. The escalation to delinquent uses that instant plus seven days. For old rows, without the field, the calculation falls back to the end of the cycle. No data migration was needed.

### Payment accumulated in a single UPDATE

The amount paid is never read and rewritten by the application. Each settlement increments the amount in the SQL itself, recomputes the balance due, and promotes the invoice to paid in the same statement, when the total is reached. The statement returns whether the invoice just became paid, and only then do the effects of that transition fire: email, activation, audit. Refunds follow the same design, with the invoice becoming refunded or partially refunded by the accumulated sum.

### What the screen shows

The invoice exposes how many attempts failed and when the next one will happen, but only while it is open and the next attempt is in the future. A retry date in the past, or on an already paid invoice, would only confuse.

## An example

A fictional clinic, R$ 349.00 monthly fee paid on day 1:

| Day | Event | Naive rule | Final rule |
| --- | --- | --- | --- |
| 3 | R$ 89.00 one-off purchase declined | Subscription past due, retries scheduled | Subscription active, one-off invoice open |
| 4 | Owner pays the one-off with another card | Subscription goes back to active | Nothing changes on the subscription |
| 36 | Fee for the cycle that ended on day 31 is declined | Past due, grace counted from day 31: ends on day 38, two days after the failure | Past due since day 36, grace until day 43 |

The atomic increment, in simplified SQL:

```sql
UPDATE invoices
   SET amount_paid  = amount_paid + $2,
       amount_due   = GREATEST(0, total - (amount_paid + $2)),
       status       = CASE WHEN amount_paid + $2 >= total THEN 'PAID' ELSE status END,
       paid_at      = CASE WHEN amount_paid + $2 >= total THEN now() ELSE paid_at END
 WHERE id = $1
RETURNING (status = 'PAID' AND amount_paid - $2 < total) AS became_paid;
```

With two webhooks settling the same R$ 349.00 invoice in installments of R$ 200.00 and R$ 149.00 at the same time, the database serializes the two updates on the same row. The first returns `became_paid = false`, the second `true`, and the payment confirmation email goes out only once. In a read, sum, and rewrite design, both would read zero and the last one would write R$ 149.00.

## Result

A declined one-off purchase does not scare a customer who is up to date. The grace period is exactly the one promised, counted from when the past-due state began. And the amount paid on an invoice does not lose updates when webhook, retry, and reconciliation arrive together. Each rule has end-to-end tests: one-off purchase, recurring module, retry, card webhook, and the authentication timeout.

## What I take from it

In a state machine, every transition has to answer "should this event move this state?". When the answer is "it depends on the type", the type has to be in the condition. And every deadline needs its own marker, written at the moment the clock starts, instead of being deduced from another field that happens to usually be nearby.
