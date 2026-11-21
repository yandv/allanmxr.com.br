---
title: A single charge for a cart with several domains
summary: "With one charge per domain, someone buying five domains would get five Pix QR codes with short deadlines to pay in a row. I created a single charge per cart, and when one domain fails only that one is refunded."
project: great-softwares
order: 17
tags: [Idempotency, Pix, PostgreSQL, Refunds, REST API]
---

Imagine an agency that builds a cart with the client's domain in `.com.br`, the `.com` version and three more variations to protect the brand, and clicks pay. Under the one-order-per-charge rule, the screen would respond with five Pix QR codes (Pix is Brazil's instant payment system), one per domain, each with its own five-minute deadline. Nobody pays five Pix payments in a row calmly. Some of them would expire along the way, and the cart would end up half done.

## The problem

Great Domains was born with a simple rule: one order, one charge, one domain. That works well for people who buy one domain at a time. For someone buying five, it becomes five independent charges, five chances to expire and five lines on the card statement.

I needed a single charge for the whole cart. The customer pays once, sees a single QR code, and each domain goes its own way after that.

## Why it wasn't trivial

One charge pays for several orders, but each order has a life of its own after payment. One domain registers, another fails because someone registered it first, a third expires because the Pix arrived late. So the batch has to be **all or nothing on creation** and **item by item on settlement**. Those are two opposite rules in the same flow.

There were three more points:

- **Resubmission.** Bad mobile network and double clicks make the customer send the same request twice. Two charges for the same cart is the worst possible bug in a checkout.
- **Frozen price.** The customer sees a total on screen. If a TLD's price (the ending, such as `.com` or `.io`) changes between the quote and the click, charging the new value without warning is wrong.
- **An external call in the middle.** The charge is created in the platform's payment system, outside my database. If I create the charge and then fail to write the orders, I'm left with a paid Pix and no orders at all.

## The solution

### Everything local first, then the external call

Creation happens in two phases. In the first, I validate and price each item through the same path as the single order, without rewriting any rule. Then I compare the sum with the total the customer saw on screen. If they diverge, I respond `409` and ask them to requote. I also check that the invoice lines add up exactly to the total, with the coupon discount already distributed between registration and privacy.

Only then do I open a PostgreSQL transaction and write everything together: one payment row with the frozen total and one order per domain, each with the holder's data frozen. If any item fails, the transaction rolls back and no external call happens. The error message points to which domain in the cart caused the problem.

In the second phase, with the orders already written, I create the standalone charge with one line per domain and one for WHOIS privacy. If the charge is definitively refused, I delete the batch's orders and release the key. If it's only an instability, the orders stay waiting and the next attempt resumes where it left off.

### Idempotency on two levels

The batch route requires the `Idempotency-Key` header. A middleware computes the hash of the body in canonical JSON (sorted keys) and stores the response. If the key is repeated with the same body, it returns the stored response with a header saying it's a replay. If the key is repeated with a different body, it's `409`.

The use case has a second layer. If the first phase finished but the second crashed, the key points to an already written payment. In that case I check that the domains and the deadlines are the same and resume the charge. And the call to the payment system itself carries the payment id as an idempotency key, so even the resumption doesn't create a second charge.

### Settlement by reconciliation

When the Pix is paid, the notification doesn't settle anything by itself. It only records the event and schedules the account's reconciliation. The reconciliation reads the charge again and decides order by order:

- pending becomes paid, and provisioning begins;
- expired with the domain still free reopens and proceeds;
- expired with the domain already taken by another order gets a refund of only its share;
- canceled but paid in a race also gets a partial refund;
- if the amount paid differs from the frozen total, I make a single refund of the amount paid and all the batch's orders fail as price out of sync.

Each partial refund uses the order id as the refund key. The daily sweep can pass over the same order again without returning the money twice.

Expiration also sees the batch. Before expiring an order, I try to cancel the charge. If the cancellation reveals it was already paid, I expire nothing and let the reconciliation resolve it.

## An example

A cart with three domains, Pix, total of R$ 139.70. The customer is on 4G and the first submission is slow.

| Time | Event | What the system does |
| --- | --- | --- |
| t=0 | Batch `POST` with key `k-7f3a` | Validates the three items, writes payment and orders in one transaction |
| t=180ms | Charge created with three lines | Returns the single QR code |
| t=900ms | The app resends the same request | The middleware finds the key with the same hash and returns the stored response |
| t=2min | Customer pays the Pix | The notification only schedules the reconciliation |
| t=2min05s | Reconciliation runs | The three orders become paid and start provisioning |
| t=3min | One of the domains fails at the registrar | Refund of R$ 39.90 for only that order, with its id as the key |
| t=24h | Daily sweep runs again | Same refund key, nothing is returned twice |

The "everything local first" rule fits in a few lines:

```ts
async function createBatch(input: BatchInput) {
  const priced = await Promise.all(input.items.map(priceItem));
  const total = priced.reduce((sum, item) => sum + item.totalCents, 0);
  if (total !== input.expectedTotalCents) throw new QuoteOutdatedError();

  // Nothing external happens until every order exists in the database.
  const { payment, orders } = await db.transaction(async (tx) => {
    const payment = await tx.payments.insert({ totalCents: total, requestKey: input.key });
    const orders = [];
    for (const item of priced) orders.push(await tx.orders.insert({ ...item, paymentId: payment.id }));
    return { payment, orders };
  });

  return billing.createCharge({ idempotencyKey: payment.id, lines: toLines(orders) });
}
```

## Result

The customer pays once and sees a single QR code, whatever the size of the cart. Resubmitting a request doesn't duplicate the charge. A price divergence becomes a clear response before payment, or an automatic refund after it. And a domain that fails doesn't drag the others down: only that order is returned.

## What I take from it

In a batch, I separate two questions. Creation has to be atomic, so everything local goes in a transaction before any external call. Settlement has to be granular, so each item is decided on its own by a reconciliation that can run as many times as it likes. And every effect involving money gets a deterministic key, because the question is never whether the operation will be repeated, but when.
