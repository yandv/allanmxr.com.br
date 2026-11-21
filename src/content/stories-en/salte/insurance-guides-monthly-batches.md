---
title: "From appointment to insurance receivable: claims, pending issues and monthly batches"
summary: "Each appointment under a health insurance plan becomes a claim, the month's claims become a batch, and the batch becomes a receivable that shrinks when the insurer issues denials. I designed the claim to be born when the consultation is finalized without putting the medical record at risk, priced from that day's table, with a pending-issues list that blocks the batch before it goes out wrong."
project: salte
order: 5
tags: [Health insurance, Billing, PostgreSQL, Accounts receivable, ERP]
---

An oncologist finalizes a chemotherapy session for a patient covered by a health insurance plan (in Brazil, a "convênio", a private plan the clinic bills directly). That visit included the consultation, an exam done in the clinic itself and two drugs applied from stock. For the clinic to get paid, all of it has to become a claim to the insurer (a "guia"), with each item at the price from that insurer's table, and at month end it has to go into a batch with the other claims. If the claim goes out with an item that has no price, an expired insurance card or a dose above the prescribed one, the insurer issues a denial (a "glosa"), meaning it refuses to pay that item, and the clinic finds out weeks later.

## The problem

Billing insurers means turning clinical events into charges, with each payer's own rules. The claim has to be born from the appointment without rework, carry the right price for the day of service, include the fees the insurer accepts and only enter the batch when nothing in it would make the insurer refuse it. Then the batch becomes a receivable, and that receivable's value has to follow what the insurer actually agrees to pay.

## Why it wasn't trivial

The medical record and billing have different weights. Finalizing the consultation is a clinical record; generating the claim depends on a price table, a billing lock and the insurer's rules. A billing failure can't undo the clinical record.

Price also has a date. The insurer's table changes, and the claim needs the price in force on the day of service, not on the day someone opens the screen. When there's no price, the temptation is to use the private price, and that produces a claim the insurer will refuse.

And a batch is a commitment. Once sent and paid, undoing it would erase the link between the money received and the claims that justify it.

## The solution

### The claim is born after the clinical commit

Finalizing the consultation writes the clinical record in the route's transaction. Only after the commit is the claim generated, and the response returns with its reference, so the screen can announce "claim generated". If generation fails, the failure becomes a log entry and the response carries the claim as null. A consumer of the consultation-finalized event runs the generation again in the background. The claim is unique per consultation, with an index and a re-read under lock, so whoever arrives second gets the claim that already exists.

Generation decides who pays from the appointment, or from the patient's insurance card when they arrived without an appointment. A private consultation stays private even if the patient has insurance, and the day of service is the clinic's day in its own timezone.

### Price from the day's table, never the private one

Each item looks up the insurer's table price in force on the day of service. With no price, the item is left without a value and the claim sits in "missing price"; it never gets the private price. When the insurer publishes the price, a repricing reads the table again, for the same day of service, and the claim leaves that state. Items typed by hand keep the typed value.

### Fees by rule, once per claim

An insurer can have fee rules, such as an administration fee whenever there's a stock drug on the claim. The claim gets one line per active rule whose trigger holds, a single time, with a unique index preventing the second. If someone removes a fee from the claim, the removal is remembered, and repricing doesn't bring it back.

Exams done in the clinic and not charged to the patient enter as procedure lines at the table price. An exam without a valid code stays without a code, never with an invented one, and shows up as a pending issue.

### Pending issues that block the batch

Each claim goes through a checklist, each check with a field, a message and whether it blocks or only warns. Examples: missing or expired insurance card, missing insurer registration or clinic code, service date in the future, submission deadline passed, authorization expired or dated after the service, item without a value, total that doesn't add up, drug expense above the prescribed dose. Warnings, such as a drug with no associated prescription, appear without blocking.

### The batch becomes a receivable

A batch groups claims from one insurer, of one type and one period, usually the month. Before closing, a preview shows what would go in and, for each excluded claim, the reason and its first pending issue. Closing takes only ready claims with no blocking pending issue, creates a receivable in accounts receivable with the insurer as the customer and marks the claims as billed with an update conditional on their state. If the number of claims moved doesn't match what was expected, everything rolls back.

The receivable belongs to the batch: it can't be edited or deleted through accounts receivable. Undoing the batch returns the claims and removes the receivable, but only while the insurer hasn't returned a remittance statement and no money has come in.

When the insurer's statement arrives, each item is matched to a batch, claim and line, and each denial is recorded with its amount and code. An item that doesn't match is kept as "unmatched", never discarded. The receivable's value becomes the billed amount minus the denied amount plus what was recovered on appeal, never below zero and never above the billed amount.

## An example

A fictional session claim:

| Item | Source | Price |
| --- | --- | --- |
| Consultation | insurer's table on the day of service | R$ 250.00 |
| Exam done in the clinic | insurer's table, as a procedure | R$ 80.00 |
| Administration fee | insurer's rule, trigger: stock drug | R$ 45.00 |
| Total | | R$ 375.00 |

A batch of 40 claims like this becomes a receivable of R$ 15,000.00. The insurer denies R$ 600.00, and the receivable goes to R$ 14,400.00. An appeal recovers R$ 200.00, and the receivable goes to R$ 14,600.00.

```ts
function batchReceivableCents(billed: number, denied: number, recoveredOnAppeal: number): number {
  // the receivable is never negative and never exceeds what was billed
  return Math.min(billed, Math.max(0, billed - denied + recoveredOnAppeal));
}

batchReceivableCents(1_500_000, 60_000, 20_000); // 1_460_000
```

If this claim's exam had had no table price on that day, the claim would sit in "missing price" and stay out of the batch, showing up in the preview with the reason, until repricing found the value.

## Result

The claim appears the moment the doctor finalizes the consultation, and no price or lock problem can undo the clinical record. The batch carries only claims that passed the checks, and the clinic sees, before closing, what was left out and why. The receivable follows denials and appeals without losing the link to the claims that justify it.

## What I take from it

Clinical records and billing get separate transactions because they have different consequences when they fail. A price is always "the price on which day". And it's worth more to block a claim in the preview, with the reason on screen, than to discover the denial in next month's statement.
