---
title: Treating a lost response from the tax authority as a state, without duplicating the invoice
summary: "When the issuing authority's response is lost, the invoice may have been issued anyway, and resending would duplicate the customer's invoice. I now treat that doubt as its own state and only move on after confirming what happened."
project: araute
order: 10
tags: [NFS-e, Idempotency, State machines, Reconciliation, TypeScript]
---

A merchant sells a consulting engagement, the payment is confirmed and Araute issues the invoice automatically. The request goes out to the issuing authority and, seconds later, times out. On my side there's no invoice and no rejection, just silence. On the authority's side, the invoice may very well have been generated a second before the connection dropped. If I read the silence as a failure and resend with another number, the service customer gets two invoices for the same sale.

## The problem

Issuing an NFS-e (Brazilian electronic service invoice) under the national standard is a synchronous call. I send a DPS, the signed service declaration that the authority turns into an invoice, and it responds with the invoice or a rejection.

Each DPS has a series and a number, and the number is reserved on my side, in a transaction, before sending. Network and timeouts can lose the response of an invoice the authority did generate. A duplicate invoice isn't a detail: canceling requires its own process and creates accounting confusion for the merchant and their customer.

## Why it wasn't trivial

A lost response is neither a rejection nor a success. It's a third outcome that a "sent, issued, failed" machine doesn't represent. And "try again" carries a trap: the natural urge to grab the next free number.

There was also a worse variant. The same CNPJ (the Brazilian company registry number) can issue invoices through another system, such as the government's web issuer or a merchant's ERP. That other system may occupy precisely the number I reserved, and the authority answers "this number already exists". But I look up the invoice by the identifier derived from the number. Finding an invoice there doesn't prove it's mine.

## The solution

### "I don't know" is a state

The internal issuing state machine gained an unknown-outcome state, reached after sending when the response is lost. For the merchant, the public status remains "processing", because nothing changed for them. Internally, that state has its own rules and its own queue.

### Reconcile before any retry

No invoice leaves that state through a new send. First I query the authority by the DPS identifier, which is deterministic: series, number and CNPJ always produce the same identifier. I check existence and, if it exists, fetch the invoice.

If the invoice exists and is mine, it moves to issued, with the data the authority generated. If it doesn't exist, the retry is released, with the same number. A periodic job drains whatever got stuck in that state.

### Never a new number because of a timeout

The number was fixed at reservation and doesn't change because of a network failure. The deterministic identifier is the second defense: resending the same DPS doesn't create a second invoice, because the authority recognizes it.

### Proof of authorship

When the authority says the number already exists, I assume nothing. I fetch the invoice and read the DPS block embedded in it, meaning what the issuer declared, not the fields the authority filled in.

1. If series, number or the provider's CNPJ don't match what I requested, or the block is unreadable, there's no proof.
2. If the declared application version isn't mine, the invoice belongs to another system.
3. If it's mine, I compare the sale's fingerprint: the customer's document, the tax code and the amount in cents. All equal, the invoice is ours and I adopt it. Anything different, it belongs to another system.

An invoice from another system is the only exception to the never-change-the-number rule. In that case I record the external occupation, reserve the next number and resend, with a cap on jumps. Once the cap is hit, issuing fails for good and raises an alert.

### Without proof, nothing changes

A query that failed, an error on the authority's side or an unreadable XML keep the invoice in the unknown-outcome state, with an alert. The next reconciliation round tries again. The system prefers to wait over deciding in the dark.

## An example

A timeline with made-up values. An R$ 1,250.00 invoice for the customer with CNPJ 12.345.678/0001-90, DPS series 1, number 4821.

```txt
t=0s      reserves number 4821 (transaction committed)
t=0.2s    POST of DPS 4821 to the authority
t=15s     timeout, no response
          internal state: unknown outcome; public status: processing
t=5min    reconciliation: query by DPS 4821 identifier
          response: exists
t=5min    fetches the invoice and reads the embedded DPS block
          application version: ours
          customer 12345678000190, code 01.07.01, amount 125000 cents: matches
          result: our invoice, adopted as issued
```

The alternative outcome, when another system occupied the number:

```txt
t=0.2s    POST of DPS 4821
t=0.6s    authority responds: number already used
t=0.9s    fetches invoice 4821 and reads the DPS block
          application version: another one
          result: external occupation recorded
t=1.0s    reserves 4822 and resends
t=1.4s    invoice issued with number 4822
```

And the case where the query fails too: the authority returns a 503 error on both reconciliation attempts. The invoice stays in processing, with an alert, and the decision waits for the next round. In none of these paths does a second invoice go out for the same sale.

The idea of the proof fits in a pure function:

```ts
type Ownership = 'ours' | 'foreign' | 'no_proof'

function proveOwnership(dps: EmbeddedDps | null, sale: ExpectedSale): Ownership {
  if (!dps) return 'no_proof'
  const sameSlot =
    dps.number === sale.number && dps.series === sale.series && dps.cnpj === sale.cnpj
  if (!sameSlot) return 'no_proof'
  if (dps.appVersion !== OUR_APP_VERSION) return 'foreign'
  const sameSale =
    dps.recipientDocument === sale.recipientDocument &&
    dps.serviceCode === sale.serviceCode &&
    dps.amountCents === sale.amountCents
  return sameSale ? 'ours' : 'foreign'
}
```

## Result

A lost response is no longer a path to a duplicate invoice. The design's worst case is now an invoice sitting in "processing" with an alert, waiting for proof, not a repeated issuance. The backlog of that state became a metric, so a degradation at the authority shows up as a growing queue before it becomes a merchant complaint.

## What I take from it

In an integration with an external system, "I don't know" is a state, not an error. Modeling the doubt explicitly is what prevents the wrong decision made in the dark. And proof of authorship has to come from what I declared, not from an identifier that another system can also occupy.
