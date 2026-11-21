---
title: "Three gateways, one subscription: choosing by what the contract requires"
summary: "Each payment gateway on the platform could do different things, and picking one with scattered ifs guaranteed a subscription stuck on a gateway that didn't support the plan. I made routing a pure function over a capability matrix."
project: salte
order: 10
tags: [Billing, Stripe, Woovi, Payment gateways, TypeScript]
---

One clinic picks Salte's annual plan, adds an extra module billed monthly and pays by card. Another prefers the monthly plan on Pix (Brazil's instant payment system), with a trial period. A third negotiated a special price with the sales team. All three go through the same checkout screen, and each one has to land on a payment gateway that can actually do what they bought. If it lands on the wrong one, the problem doesn't show up that day: it shows up on the first renewal, when the gateway doesn't know how to charge the extra module.

## The problem

The platform's billing, which charges the clinics themselves for the Salte subscription, was born talking to three gateways. Stripe charges cards and does practically everything: recurring modules, immediate proration on plan changes, pause, custom pricing, one-off purchases on the stored card. Woovi charges subscriptions through Pix Automático (Pix recurring debit), including with a trial period, and almost nothing else. A third gateway charges simple card subscriptions and does one-off purchases through a hosted checkout page.

Each has its own set of capabilities, and they don't overlap cleanly. The decision of "which gateway serves this contract" is a business one, but it had every chance of turning into a tangle of conditionals scattered across subscription creation.

## Why it wasn't trivial

The choice depends on several traits at once: payment method, recurring modules already on the subscription, custom pricing, plan changes with immediate proration, one-off purchases, trial period, pause and temporary discount. Any new combination can rule out a gateway.

Besides that, whoever runs the business needs to change the preference order without a deploy: turn a gateway off for new contracts without affecting existing ones, or prioritize another for cost. And when no gateway fits, the answer has to say why, gateway by gateway, otherwise nobody knows whether the problem is the configuration or the plan.

The gateways also differ in billing model. On Stripe, Salte decides when to charge: a cycle job generates the invoice and submits the charge. On Woovi, recurrence is managed by the gateway itself, which creates the charges on its own and notifies via webhook. That execution mode has to travel with the decision.

## The solution

### The contract describes the need

Before creating the subscription, checkout builds a contract: payment method and a list of booleans for what the subscription requires. There's no mention of any gateway in it. It's the description of what has to happen during that subscription's life.

### The matrix describes the gateways

Each gateway has a row in a capability matrix: it can or can't do each of the contract's requirements. The matrix is a code file, reviewed in a pull request, with the reason for refusing each capability written in readable text.

### The router is a pure function

Routing takes the candidates already sorted by priority (coming from the operator's configuration, filtered by payment method) and the contract. It walks the list: skips whoever is turned off for new contracts, checks the matrix and returns the first compatible one, along with the execution mode. If it isn't the first on the list, the decision records why the primary was refused. If none fits, it returns a failure with each gateway's reasons.

No database, no network, no clock. That made routing testable with a table: each row is a contract and the expected gateway.

### Adapters behind an interface

Each gateway has an adapter with the same interface for the rest of billing: create customer, create subscription, charge, refund, cancel. Business rules talk to the interface, and each gateway's webhook is translated into the same internal events. When Salte started charging a new subscription through Araute, the gateway got its own adapter and creation flow, but the choice stayed in the same router: a new row in the matrix was enough.

## An example

A simplified matrix, with illustrative values:

| Capability | Stripe | Woovi | Gateway C |
| --- | --- | --- | --- |
| Recurring module on the subscription | yes | no | no |
| Custom price | yes | no | no |
| Immediate proration | yes | no | no |
| Trial period | yes | yes | no |
| Pause | yes | no | no |

And the router, reduced to the essentials:

```ts
type Gateway = 'STRIPE' | 'WOOVI' | 'GATEWAY_C';
type Need = 'recurringAddons' | 'customPrice' | 'immediateProration' | 'trial' | 'pause';
type Candidate = { gateway: Gateway; enabledForNew: boolean };

const CAPS: Record<Gateway, Record<Need, boolean>> = {
  STRIPE: { recurringAddons: true, customPrice: true, immediateProration: true, trial: true, pause: true },
  WOOVI: { recurringAddons: false, customPrice: false, immediateProration: false, trial: true, pause: false },
  GATEWAY_C: { recurringAddons: false, customPrice: false, immediateProration: false, trial: false, pause: false },
};

function route(candidates: Candidate[], needs: Need[]) {
  const rejected: { gateway: Gateway; missing: Need[] }[] = [];
  for (const { gateway, enabledForNew } of candidates) {
    const missing = needs.filter((need) => !CAPS[gateway][need]);
    if (enabledForNew && missing.length === 0) return { ok: true, gateway, rejected };
    rejected.push({ gateway, missing });
  }
  return { ok: false, rejected };
}
```

A made-up clinic wants to pay by card with a recurring module, and the operator put Gateway C first for cost:

```ts
route(
  [{ gateway: 'GATEWAY_C', enabledForNew: true }, { gateway: 'STRIPE', enabledForNew: true }],
  ['recurringAddons'],
);
// { ok: true, gateway: 'STRIPE', rejected: [{ gateway: 'GATEWAY_C', missing: ['recurringAddons'] }] }
```

The same clinic, without the extra module, would land on Gateway C, as the operator wanted. And if Stripe were turned off for new contracts, the answer would be a refusal with both reasons, before any charge.

## Result

Adding a new requirement to the contract became three steps: a field on the contract, a column in the matrix, a case in the test table. The operator changes priority and turns gateways on or off for new contracts through configuration, and existing subscriptions stay on the gateway where they were born. No subscription is born on a gateway that can't renew it.

I also wrote smoke tests against the real sandbox environments of two gateways, behind a flag, to check that each adapter honors the interface contract against the real API and not just a mock.

## What I take from it

When the question is "who can do this?", the answer fits in a table, and the decision fits in a pure function over it. Separating what the customer needs from what each vendor offers makes the rule readable for people who don't read the code and turns switching vendors into a data change.
