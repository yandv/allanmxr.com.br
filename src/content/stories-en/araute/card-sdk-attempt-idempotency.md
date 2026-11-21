---
title: "Switching cards after a decline without reloading the checkout"
summary: "After a decline, the buyer needs to be able to try another card without getting the recorded decline back or risking a double charge on a network retry. I scoped the idempotency key per attempt in the checkout SDK, and the new attempt works without reloading the page."
project: araute
order: 12
tags: [SDK, TypeScript, Idempotency, 3DS, Checkout]
---

Imagine a buyer who types their card into a store's checkout, clicks pay, and the bank declines: insufficient funds. They grab another card from their wallet, type it in and click again. If the screen shows "payment declined" again, instantly, without even asking the bank, the second card was never tried and the merchant lost the sale. That scenario showed up early, in the SDK's test mode, and the cause lies in where the idempotency key boundary is drawn.

## The problem

Araute's transparent checkout lets the merchant accept cards on their own page, without redirecting the buyer. The card number (the PAN, in industry terms) can't pass through the merchant's server or Araute's, because that would bring the full compliance burden of storing cards. It's typed into a secure form, inside an acquirer iframe, and the merchant assembles that form with [`@araute/js`](https://docs.araute.com/guias/checkout-transparente), a public browser SDK with no runtime dependencies.

The form had to survive real use: a declined card, a 3DS challenge (the step where the issuing bank asks the buyer to confirm, via app or code) opening and closing, a tab forgotten in the background. And the merchant shouldn't have to write any special handling for it.

## Why it wasn't trivial

Each payment attempt charges money, so it needs an idempotency key. The `Idempotency-Key` header rule is clear: same key, same response. That creates two opposite traps.

If the second attempt reuses the first one's key, the API returns the recorded response of the first, which was a decline. That's the buyer from the opening.

If every call generates a new key, a network retry (the request went out, the response got lost, the browser tries again) becomes a second charge.

On top of that, the acquirer form has a short validity of 15 minutes. Renewing with the tab hidden wastes renewals. Renewing in the middle of a 3DS challenge destroys the challenge.

## The solution

### The client_secret model

The merchant's backend creates the payment with the secret key and hands the browser only a `client_secret`, which is good for mounting and confirming that payment and nothing else. It always travels in the `Authorization` header, never in the URL, so it doesn't end up in `Referer`, server logs or browser history. Confirmation goes from the buyer's browser so the anti-fraud analysis receives their real IP.

### Scope the key to the intent to charge

The right question isn't "which payment is this?" but "which attempt is this?". The SDK's HTTP client keeps keys per scope. The first confirmation uses a stable key for that scope, so a network retry reuses the same key and gets the same response. A new attempt, after a previous one has finished, gets its own key. Within an attempt, a retry is a replay. Between attempts, each one is a new operation.

### Renew without getting in the way

The SDK schedules the form renewal a bit before it expires. If the tab is hidden, it postpones until the tab is visible again. While the buyer is in a 3DS challenge, the timer is cancelled and only resumes when the challenge ends. If a submit catches an already expired form, the SDK renews right away. In every case, what the buyer already typed is preserved.

### A decline doesn't close the form

Only an approved payment stops the renewal. A declined card leaves the form open for another attempt, without reloading the page.

### A submit that never hangs

Whoever uses their own pay button calls `submit()`, which resolves when the attempt ends: with the result, with a form validation error, or when the buyer enters the 3DS challenge. The merchant is never left with a button stuck on "processing".

### The browser doesn't confirm payment

The result that reaches the browser, in the `onResult` callback, is for switching screens. What releases the order is the webhook or a payment lookup from the backend, because the browser is controlled by whoever is on the other side. The documentation says this prominently.

## An example

The buyer's session from the opening, now with the right boundary:

```txt
t=0s     confirm (card A)          Idempotency-Key: k1  -> sent
t=8s     network drops before the response; SDK retries
t=9s     confirm (card A)          Idempotency-Key: k1  -> replay: "declined"
t=40s    buyer switches card
t=41s    confirm (card B)          Idempotency-Key: k2  -> 3DS challenge opened
t=41s    renewal timer suspended
t=75s    challenge completed        -> "approved"; renewal stopped
```

The retry at second 9 didn't create a second attempt with card A. Switching to card B didn't receive the old decline. On the SDK side, the idea fits in a few lines:

```ts
class ApiClient {
  private keys = new Map<string, string>()

  private keyFor(scope: string | null): string {
    // no scope: new operation, new key
    if (scope === null) return crypto.randomUUID()
    // with scope: a retry of the same operation reuses the key
    let key = this.keys.get(scope)
    if (!key) {
      key = crypto.randomUUID()
      this.keys.set(scope, key)
    }
    return key
  }

  confirm(type: 'card') {
    return this.post('/confirm', { type }, this.keyFor(`confirm:${type}`))
  }

  confirmRetryAfterDecline() {
    return this.post('/confirm', {}, this.keyFor(null))
  }
}
```

For the merchant, none of this shows. The integration is still mounting the field and reacting to the result:

```ts
const araute = Araute(clientSecret)
await araute.mountCard('#card', {
  onResult: (result) => showThanks(result.paid),
  onError: (error) => showRetry(error.code),
})
```

## Result

Buyers can try again after a decline without reloading the page, and a network retry never becomes a second charge. The SDK ships with an ESM build and a global bundle, and with a public table of stable error codes, separating the ones that happen before the form appears from the ones that arrive afterwards, during renewal.

With a test key, the SDK mounts an Araute test form in place of the acquirer's form, with cards that approve and decline. That mode is exactly what made the key problem visible early: declining and trying again became a trivial scenario to reproduce.

## What I take from it

Idempotency protects an intent, and the boundary of the intent has to be chosen carefully. Here, the intent wasn't "pay this order", it was "charge this card now". One key per attempt, and each new attempt gets its own.
