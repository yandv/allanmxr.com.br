---
title: A ledger where the database only accepts INSERT
summary: "A balance the application adds to and subtracts from can't explain where it came from, and a mistake fixed by hand erases its own trail. I built a ledger where the database refuses edits, and explaining any balance became a query."
project: araute
order: 6
tags: [Ledger, PostgreSQL, Double-entry, Idempotency, Payments]
---

A merchant opens the dashboard, sees their available balance and asks: why that amount? The only acceptable answer in a payments platform is a list of entries that add up to exactly that number, each pointing to the charge, fee or refund that originated it. "Because the column says so" is not an answer. That question is what I had in mind when I designed Araute's ledger.

## The problem

A balance stored as a field the application increments and decrements has two flaws. It can't explain where it came from. And when a calculation goes wrong, the natural fix is to edit the row, which erases precisely the trail of the mistake.

On top of that, money in a payments platform has several natures at once: what's still pending, what's already owed to the merchant, what the Pix provider (Pix is Brazil's instant payment system) or the acquirer is yet to pay out, the platform fee, reserves for disputes and refunds, a customer's credit. An entry in the wrong account can't be something you only discover at month-end close.

## Why it wasn't trivial

Immutability has to withstand the application's own bugs, not just malicious users. If the guarantee lives only in code, the first forgotten `UPDATE` in a fix-up script undoes it.

And the writers to the ledger are queue workers, which deliver messages at least once. The same event can arrive twice, and a duplicated credit is money that doesn't exist.

## The solution

### Double-entry

Each financial event becomes a journal, a group of entries where total debits equal total credits. The application checks this before writing, and the database checks it again when the journal closes, in the same transaction. An unbalanced journal aborts the whole transaction; half a journal is never persisted.

Because every journal closes at zero, the whole ledger closes at zero at any instant. That sum became the master check: if it isn't zero, there's a bug, and I know right away.

### Immutable in the database, not in the application

The entries table only accepts INSERT, and PostgreSQL enforces it. The application's database user has no UPDATE or DELETE permission on that table, and a trigger raises an error on both as a second layer. Even a script run with the wrong credentials runs into the trigger.

### Corrections only through inverse entries

A mistake is corrected with a reversal journal: it mirrors the original with directions swapped and references the journal it's undoing. The balance is always the sum of everything. The mistake stays visible, and so does the correction.

### Every entry has an origin

No loose entries. Each entry points to the financial object that generated it, such as a charge, a refund or a payout. There's no "adjustment" without an owner.

### Deterministic key per journal

Each journal has a key derived from the event that originated it, and the database has a uniqueness constraint on it. If the worker reprocesses the same event, the second INSERT collides and the worker treats it as "already booked". A concrete case: releasing a charge's pending balance uses a per-charge key, so a periodic job running twice never releases the same money twice.

### Integer cents and rounding with a destination

Amounts are positive integers in cents, and the direction (debit or credit) carries the sign. Every split that produces a fraction of a cent, such as a percentage fee, uses the same half-up rounding (half a cent rounds up), and the remainder goes to a designated account inside the journal. Nothing vanishes, because vanishing would break the balance.

### Balances with their own rules

Some accounts can never go negative, and an operation that would push them negative is rejected. Others can, by explicit decision: if a chargeback comes out before the merchant has a balance, the amount payable to them goes negative, which means they owe the platform. That's flagged, not blocked, because the entry has to reflect reality.

## An example

A R$ 100.00 Pix charge with a 1.99% fee. The fee comes to exactly 199 cents, so there's no remainder. When the payment is confirmed, the journal looks like this:

| Account | Debit | Credit |
| --- | ---: | ---: |
| Receivable from provider | 10000 | |
| Merchant pending balance | | 9801 |
| Platform fee revenue | | 199 |
| **Total** | **10000** | **10000** |

Days later, the merchant refunds the charge. Nothing is edited. A new journal comes in, referencing the charge, with directions swapped. The merchant's balance is the sum of the two lines, and the history shows both.

The write, simplified, looks like this:

```sql
BEGIN;

INSERT INTO journals (id, journal_key, source_kind, source_ref)
VALUES ('jrn_01', 'charge.succeeded:ch_123', 'charge', 'ch_123')
ON CONFLICT (journal_key) DO NOTHING
RETURNING id;
-- no row returned: the event was already booked, the worker stops here

INSERT INTO journal_entries (journal_id, account, direction, amount_cents) VALUES
  ('jrn_01', 'provider_receivable', 'debit',  10000),
  ('jrn_01', 'merchant_pending',    'credit',  9801),
  ('jrn_01', 'platform_fee',        'credit',   199);

COMMIT; -- the closing trigger checks debit = credit before accepting
```

And any attempt to "fix" a value directly fails in the database:

```sql
UPDATE journal_entries SET amount_cents = 9800 WHERE journal_id = 'jrn_01';
-- ERROR: journal entries are append-only
```

## Result

The ledger became the platform's accounting source of truth. Reconciliation with the provider compares the statement against it, and discrepancies become records of their own instead of silent adjustments. A refund is only booked when it reaches its final success state, never ahead of time while still pending.

Answering "why is the balance this?" became a query, not an investigation.

## What I take from it

Immutability is a property of the database, not the application. Permissions and a trigger cost half a dozen lines and protect against the most likely mistake, which is mine. And every journal needs a deterministic key from day one, because whoever writes to a ledger is going to be re-executed.
