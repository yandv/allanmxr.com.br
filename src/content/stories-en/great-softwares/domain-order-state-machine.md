---
title: "Refund or move on: the domain order that fails halfway"
summary: "Between payment and a registered domain any step can fail, and the same failure calls for a refund or for carrying on depending on the moment. I made every order end in an explainable state, with no charge for an undelivered domain."
project: great-softwares
order: 16
tags: [State machine, Cloudflare Workflows, PostgreSQL, Idempotency, Refunds]
---

A Great Domains customer picks `minhaloja.com.br`, pays by card and closes the tab. On our side, a sequence begins: confirm the payment, create the DNS zone, register the domain at the registrar, wait for the confirmation the registrar sends later, notify the customer. Now imagine the worker dies right after sending the registration request, before storing the response. Was the domain registered or not? Should the money go back or not? I needed every order to always end in a state I could explain, even when a step fails at the worst possible moment.

## The problem

Buying a domain is a distributed transaction without a transaction. The money goes through a payment method, the DNS zone lives on Cloudflare, registration happens at an external registrar (Registro.br, the .br registry, for `.br`; OpenSRS for generic TLDs), and some confirmations arrive asynchronously. None of these systems takes part in a common commit.

Any step can fail, be slow, or run twice. And the customer has already paid.

## Why it wasn't trivial

**The same failure has opposite meanings.** If registration fails before the domain exists at the registrar, the right thing is to refund. If it fails after the domain exists, refunding is returning the money for a purchase that delivered the product. Treating both the same way is a money bug in both directions.

**Payment arrives late.** A 3DS (the card's extra authentication) confirmed after the order expired, or a Pix (Brazil's instant payment system) paid at the last second. The order was already expired and has to come back to life.

**The same domain can't have two owners.** Two accounts can try to buy the same name at the same time, and only one can get it.

**Processes die.** A Workflow can hang or vanish halfway, and nobody will notice if nobody is watching.

## The solution

### Explicit states and edges

The order has nine states: `PENDING_PAYMENT`, `PAID`, `PROVISIONING`, `PENDING_REGISTRY`, `REGISTERED`, and the detours `EXPIRED`, `CANCELLED`, `FAILED`, `REFUNDED`. A table in code lists which transitions are allowed. `REGISTERED`, `CANCELLED` and `REFUNDED` have no way out: they're terminal. `FAILED` only leaves to `REFUNDED`. `EXPIRED` only leaves to `PAID`.

Every state change goes through a single function, which validates the edge against the table and then runs a conditional `UPDATE`: it only changes if the current status is still one of the expected ones. It's a compare-and-swap in the database. If the function returns empty, another execution got there first, and the caller treats that as "already done", not as an error.

### A late payment only reopens if the domain is still free

`EXPIRED` can go back to `PAID` within a 72-hour window. The single-owner guarantee is twofold: a query that looks for another live order for the same domain, from any account, and a partial unique index in the database that only allows one order in a live state per domain. If the name was already taken, the late payment becomes a refund.

### Provisioning as a durable Workflow

Provisioning runs in a Cloudflare Workflow, a durable execution mechanism in which each completed step is saved and a resume skips the steps already done. The first step does the CAS from `PAID` to `PROVISIONING`. Then come the DNS zone, registration and completion.

The registration step is idempotent: before registering, it asks the registrar whether the domain is already in the account. And one fixed rule: an infrastructure error after registration never triggers a refund. It only records the problem and leaves the order to recovery.

### Recovery by sweep

Every 15 minutes, a cron job lists orders in `PAID`, `PROVISIONING` and `PENDING_REGISTRY`, checks the health of each one's Workflow instance (alive, dead or missing) and asks the registrar whether the domain exists. With those three pieces of data, a pure function decides what to do.

### Refund as an idempotent primitive

The refund reads the payment state, cancels what needs canceling and treats "already refunded" as success. Another cron job relists orders with a pending or failed refund and tries again, without depending on the Workflow that originated the failure. An error on one order doesn't interrupt the sweep of the others.

## An example

The recovery decision fits in a pure function, with no database or network, which makes it trivial to test with a table of cases:

```ts
type Health = "alive" | "dead" | "missing";
type Action = "skip" | "restartFromStart" | "restartFromRegister" | "failAndRefund" | "manual";

const RESTART_WINDOW_MS = 72 * 60 * 60 * 1000;

function decideRecovery(
  order: { status: string; paidAt: Date | null },
  health: Health,
  existsAtRegistrar: boolean | null, // null = the registrar didn't respond
  now: Date,
): Action {
  if (health === "alive") return "skip";

  if (order.status === "PAID") return health === "dead" ? "restartFromStart" : "skip";

  // Only confirmed absence of the domain entitles an automatic refund.
  if (existsAtRegistrar === false) return "failAndRefund";
  if (existsAtRegistrar === null || health === "missing") return "manual";

  const withinWindow = order.paidAt !== null && now.getTime() - order.paidAt.getTime() <= RESTART_WINDOW_MS;
  return withinWindow ? "restartFromRegister" : "manual";
}
```

Back to the opening scene, with fictional times:

| Time | Event | State |
| --- | --- | --- |
| 14:00:00 | Payment confirmed | `PAID` |
| 14:00:02 | Workflow does the CAS and creates the DNS zone | `PROVISIONING` |
| 14:00:05 | Registration request sent; the worker dies before storing the response | `PROVISIONING` |
| 14:15:00 | Cron sees a dead instance; registrar says the domain exists | `restartFromRegister` |
| 14:15:01 | Workflow resumes, skips DNS (already saved), registration detects it already exists | `REGISTERED` |

The customer receives the domain 15 minutes later, with no double charge and no undue refund. Had the registrar answered that the domain doesn't exist, the same cron would have taken the order to `FAILED` and then to `REFUNDED`. Had the registrar not answered, the order would have gone to manual decision, with a log that becomes an alert.

## Result

Every order ends in a terminal state that can be explained: registered, canceled or refunded. A partial failure leaves no order stuck and no money charged without delivery. Two concurrent processes never apply the same transition twice, because the database refuses the second CAS. And the most delicate part, deciding between resuming and refunding, is a pure function covered by table tests.

## What I take from it

Separate "failure before the point of no return" from "failure after". Only the first entitles automatic compensation. The second is resolved by moving forward, with idempotent steps that can be repeated without fear. When you can't tell which side of the line you're on, the right answer is to stop and call a person, not to guess.
