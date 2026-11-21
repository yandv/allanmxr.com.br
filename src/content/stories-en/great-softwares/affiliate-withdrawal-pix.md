---
title: Affiliate Pix withdrawals without ambiguous keys and without blowing the monthly cap
summary: "A mistyped Pix key would only surface days later, at payout, with the balance already deducted. I designed the withdrawal flow to validate data at registration time and to keep two simultaneous clicks from ever exceeding the monthly cap."
project: great-softwares
order: 21
tags: [Pix, Data validation, Concurrency, Affiliates, Money in cents]
---

Imagine a Great Apps affiliate who accumulates commission, opens the withdrawal screen, asks for R$ 200 and gets a confirmation. Days later the operation tries to pay the Pix (Brazil's instant payment system) and the institution rejects it: the registered key was an 11-digit number treated as a CPF (the Brazilian individual taxpayer number), but it was actually his phone number without the `+55`. The balance has already left the affiliate's account, the money hasn't arrived anywhere, and the case turns into manual support. It's a small error, and avoiding it came down to a design decision: validate the data when it comes in, not when the money goes out.

## The problem

The affiliate program turns commission into a balance, and the affiliate requests a Pix withdrawal of that balance. The flow mixes money with hand-typed banking data: the holder's document (CPF or CNPJ, the Brazilian company registry number) and the Pix key.

The rules depend on that data. Individuals have a monthly withdrawal cap of R$ 350. Companies have no cap, but must attach the invoice as a PDF. The code decided between individual and company by looking at the length of the document. A document with wrong digits, or with an odd length, ended up on the wrong rule.

## Why it wasn't trivial

**An 11-digit Pix key is ambiguous.** It can be a CPF or a phone number without the country code. Many phone numbers also pass the CPF check digit. Guessing wrong sends the Pix to another person or to nowhere.

**Legacy data can't lock out people who already use the product.** There were older affiliates with badly formatted documents. If the new validation rejected any edit to the registration, an affiliate who only wanted to change the holder's name would be stuck.

**The monthly cap is an aggregate rule.** "The sum of the month's withdrawals doesn't exceed R$ 350" depends on all the other withdrawals. Two simultaneous requests, each reading the total before the other writes, pass together and blow the cap.

**Floating-point money lies.** Comparing `99.995` with another value rounded via `toFixed` gives different results depending on the calculation path.

## The solution

### Validate when the data comes in

The affiliate update route passed the body almost straight to the database. I put validation at the write points, with partial-update semantics: the document is only validated when it comes in the payload. Someone who edits only the name isn't blocked by the old data.

A validation module classifies the document (CPF or CNPJ, with check digit) and the Pix key (CPF, CNPJ, phone number, email or random key). Two new rejections cover the riskiest cases:

- **ambiguous key**: the 11-digit number passes as a CPF and also has the shape of a phone number. The message explains what to do: if it's a phone number, enter it with `+55`; if it's a CPF, it must be the holder's;
- **key that is someone else's document**: a valid CPF or CNPJ, but different from the registered holder's document.

On write, the key is normalized: digits only for CPF and CNPJ, explicit `+55` for phone numbers. That way the operation never receives a format it has to interpret.

### Withdrawal request in cents

Every value becomes an integer in cents before any comparison. The minimum withdrawal is 2500 cents, the individual's monthly cap is 35000. The decision between individual and company now uses the validated document and the key classification, not the length of a string.

### Balance and cap protected against concurrency

Deducting the balance is an atomic decrement in the database, not "read, subtract, write". Only after that is the withdrawal transaction created as pending.

For the monthly cap, I used an optimistic check in two steps. Before writing, I sum the month's withdrawals (not counting canceled and rejected ones) and refuse if the new request exceeds the cap. After writing, I sum again. If the total now exceeds the cap, another simultaneous request got in alongside: I return the balance, cancel the transaction I just created and respond with the amount still available. For companies, if the invoice upload fails, the same rollback happens, so a company withdrawal never exists without an invoice.

### Commission that converges

Commission comes from Stripe invoices, and the amount can change through a coupon between issuance and payment. A recalculation runs near the due date and applies the same coupon rule used in the rest of billing. Invoices with nothing pending are skipped, so the process converges instead of redoing work. A periodic task consolidates into the balance the pending commissions older than a month, in batches.

## An example

An individual affiliate has already withdrawn R$ 200 this month. They double-click the R$ 100 withdrawal button, and both requests arrive together. Fictional values:

| Time | Request A | Request B | Month total |
| --- | --- | --- | --- |
| t=0 | month sum: 20000 | | 20000 |
| t=5ms | | month sum: 20000 | 20000 |
| t=10ms | 20000 + 10000 ≤ 35000, writes | | 30000 |
| t=14ms | | 20000 + 10000 ≤ 35000, writes | 40000 |
| t=20ms | recount: 40000 > 35000, rolls back | | 30000 |
| t=22ms | | recount: 30000 ≤ 35000, proceeds | 30000 |

In this scenario request A recounted first, saw both withdrawals written and rolled back its own. B recounted after the rollback and proceeded. In the worst interleaving both roll back and the affiliate tries again: the system errs on the safe side, never on the side of paying above the cap.

```ts
async function requestWithdrawal(affiliate: Affiliate, amountCents: number) {
  if (amountCents < 2500) return refuse("Minimum withdrawal is R$ 25.00.");
  if (affiliate.balanceCents < amountCents) return refuse("Insufficient balance.");

  const isCompany = isCnpj(affiliate.pixKey) || isCnpj(affiliate.holderDocument);
  if (!isCompany && (await monthlyTotal(affiliate.id)) + amountCents > 35000) {
    return refuse("Monthly withdrawal limit for individuals reached.");
  }

  await db.decrement("affiliates", affiliate.id, "balance_cents", amountCents);
  const withdrawal = await db.insert("withdrawals", { affiliateId: affiliate.id, amountCents, status: "pending" });

  // The first check can't see simultaneous requests; the recount
  // after writing can, and it undoes its own request if the cap was exceeded.
  if (!isCompany && (await monthlyTotal(affiliate.id)) > 35000) {
    await db.increment("affiliates", affiliate.id, "balance_cents", amountCents);
    await db.update("withdrawals", withdrawal.id, { status: "canceled" });
    return refuse("Monthly withdrawal limit for individuals reached.");
  }
  return withdrawal;
}
```

## Result

The affiliate can only register a key that Pix has a real chance of accepting, and when the number is ambiguous they're guided right away, not days later. The individual and company rule is based on the validated document. Two clicks on the button don't blow the cap, and no company withdrawal is left without an invoice.

## What I take from it

Validate data at the moment it comes in, not when the money is about to leave: at entry, an error costs a message; at exit, it costs a support ticket. Store and compare money as integers. And when a rule depends on an aggregate, like a monthly cap, count again after writing. It's the cheapest way to close the race without a distributed lock.
