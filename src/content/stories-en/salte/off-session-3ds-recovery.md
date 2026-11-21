---
title: Recurring card billing when the bank requires 3D Secure
summary: "On automatic renewal, with the customer off screen, the bank may require cardholder authentication, and that is not a decline: no retry fixes it. I designed a dedicated state for this case, a notice to the clinic, and a screen that completes 3D Secure."
project: salte
order: 11
tags: [Stripe, 3D Secure, Billing, Subscriptions, TanStack Start]
---

It is renewal day for a clinic on the monthly plan. At three in the morning, the billing job tries the stored card, and the bank answers that it needs a confirmation from the cardholder in the app. The clinic owner is asleep. She has a valid card and wants to pay; she just needs to press a button. As I was closing the design of the platform's dunning, this was the case that separated a billing system that insists blindly from one that knows how to ask the right person for help.

## The problem

3D Secure is the step where the issuing bank asks the cardholder for an extra confirmation, in the app or by code. In purchases with the person present, the checkout screen handles it on the spot. In recurring billing, done without the customer on screen (what gateways call off-session), the bank can still demand that confirmation. In Stripe, this comes back as `authentication_required`.

The first version of dunning had two paths for a charge: success or failure, and failure went to retries without the customer present. Running smoke tests against Stripe's test environment, with the test card that requires authentication, it became clear that this third outcome fit neither. An authentication request never goes through without the customer: treated as a failure, every retry would come back the same until dunning reached cancellation.

## Why it wasn't trivial

Telling the case apart is only the beginning. Once it is told apart, the authentication has to happen in the browser, with the payment intent's `client_secret`, a short-lived secret that lets that payment be completed. It cannot be stored in the database, and the webhook that reports the problem does not carry it.

Then, Stripe has a barely documented behavior in this scenario. When the off-session charge fails because of authentication, the payment intent goes back to the "requires payment method" state and the card leaves it: it survives only inside the last error. Calling the 3D Secure confirmation without resending the card fails with "incompatible payment method".

Finally, a charge waiting for authentication stays alive. If the clinic owner, instead of authenticating, prefers to pay the invoice with another card, the rule of one live attempt per invoice would block the new payment. And canceling the old attempt cannot open the door to the customer paying twice.

## The solution

### A dedicated state for "needs the customer"

The Stripe adapter maps `authentication_required`, when there is still a live payment intent, to a dedicated charge state: requires action. An ordinary decline stays on the usual path. The retry schedule only resends failed charges, so it never blindly insists on a charge that is waiting for the customer.

The subscription still goes past due, on purpose. That way the grace period runs: if the clinic never authenticates, the normal escalation to cancellation still applies. The difference is that it gets notified.

### Notify once, fetch the secret on demand

Side effects fire only on the transition to "requires action": an email with a link to authenticate, a notification in the app's bell, and an audit record. A redelivered webhook for a charge already in that state refreshes the next-action data but does not send another email.

To complete it, the front end calls an authenticated route that lists the clinic's pending charges. For each one, the API fetches the `client_secret` and the card from Stripe at that moment. None of it is stored. The route requires a new permission to view the subscription's finances, because not every clinic member should see charges.

### Resend the card Stripe detached

Every response that leads to 3D Secure (at signup, in the pending list, on the invoice, and on the one-off purchase) carries, along with the secret, the card identifier, read from the payment intent or from its last error. The front end resends the card on confirmation. On the web front end, I built a server-rendered 3D Secure page, which the email points to, and payment with authentication straight from the invoice receipt.

### Pay with another card without paying twice

When an invoice is paid manually by card, the API replaces the charge waiting for authentication before charging the chosen card: it cancels the uncaptured payment intent in Stripe, which from then on can never be captured, and marks the local charge as canceled. A charge that is being processed at that very moment is not touched.

## An example

The timeline of a fictional R$ 349.00 renewal:

```text
day 10, 03:00  cycle job generates the invoice and charges the card with the customer off screen
day 10, 03:00  Stripe: authentication_required
               charge "requires action", subscription past due, no retry
day 10, 03:01  "confirm your payment" email and in-app notification
day 10, 09:15  owner opens the link, the page asks the API for pending charges
day 10, 09:15  API fetches the secret and the card from Stripe, returns them without storing
day 10, 09:16  front end confirms with the secret and the card, bank asks for the app
day 10, 09:17  success webhook: invoice paid, subscription back to active
```

The core of the classification, simplified:

```ts
type Outcome = 'SUCCEEDED' | 'FAILED' | 'REQUIRES_ACTION';

function classifyOffSessionError(code: string | undefined, intentStillUsable: boolean): Outcome {
  // an authentication request never goes through without the customer: retrying only delays cancellation
  if (code === 'authentication_required' && intentStillUsable) return 'REQUIRES_ACTION';
  return 'FAILED';
}

function cardToResupply(intent: { payment_method?: string; last_payment_error?: { payment_method?: string } }) {
  // after the off-session failure, the card only exists inside the last error
  return intent.payment_method ?? intent.last_payment_error?.payment_method ?? null;
}
```

If at 09:15 the owner had preferred to pay with another card, the pending intent would be canceled first, and the invoice would receive a single charge.

## Result

A renewal that asks for authentication does not turn into a silent cancellation. The clinic gets the notice, completes 3D Secure on a screen built for it, and goes back to active in the same webhook that confirms the payment. The end-to-end tests cover required authentication going to "requires action", an ordinary decline staying in dunning, dunning never resending a charge that is waiting for the customer, the route's permission, and the race with reconciliation. A smoke test against Stripe's test environment, with the test card that requires authentication, checks the behavior of the real API and not just that of a mock.

## What I take from it

"Failed" is too broad a word for payments. A decline, insufficient funds, and an authentication request call for opposite reactions: insist, wait, or call the customer. When the right reaction depends on a person, the system has to turn the error into a clear request to them, instead of trying to fix it alone until it gives up.
