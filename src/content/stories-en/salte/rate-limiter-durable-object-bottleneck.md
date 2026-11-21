---
title: "Rate limiting in Workers: Durable Objects only where global accuracy matters"
summary: "The first design of the request limiter counted everything in Durable Objects, for accuracy. A load measurement showed the price: about 330 ms per request and queuing on parallel calls. I separated the limits that need global accuracy from those that don't, and the floor dropped to 45 ms."
project: salte
order: 15
tags: [Cloudflare Workers, Durable Objects, Rate limiting, Performance, Hono]
---

An ERP screen, like the clinic's schedule, fires several API calls at once: professionals, rooms, time slots, appointments. All lightweight, several already cached. Before any of them reaches the handler, it passes through the request limiter, which protects the API against abuse. The limiter is infrastructure nobody sees, and for that very reason I wanted to know how much it cost on every request.

## The problem

The first design of the limiter ran entirely on Durable Objects. A Durable Object is an object with a single identity worldwide: for each name there is exactly one instance, and it processes calls one at a time. That is exactly what you want to count login attempts accurately, and that is why it started this way: the same guarantee for every limit.

In a load measurement round on the development environment, the price of that guarantee showed up. A request that stopped before the limiter, a 401 for lack of a session, answered in 20 ms. An authenticated request with everything cached took 335 ms. Ten simultaneous calls to the same route answered in 324, 652, 998 ms, and so on up to 3483 ms: an almost fixed step of 330 ms per call. That is the shape of a queue.

The cause was the key of each route's global limit, which mapped to a single object for the whole platform. Every request to that route, from any clinic, went through it in line.

## Why it wasn't trivial

The obvious way out would be to swap everything for Cloudflare's native limiter, a rate limiting binding that counts locally in each data center, with no trip to a central object. It is fast, but approximate: each location counts its own, and the global total is not exact.

For most routes, that does not matter. Nobody needs global accuracy to limit reads of the schedule. But there are limits where accuracy is the reason they exist: login and MFA attempts, transaction PIN, money leaving the clinic's account, refunds, payouts, webhooks. There, an attacker spreading attempts across data centers must not gain extra attempts.

On top of that, the limiter had behaviors the native binding does not offer: a window that escalates with each abuse, progressive delay, and giving the attempt back when the request fails validation. Any limit that depended on that had to stay in the object.

## The solution

### One rule to decide who leaves the object

Each limit configuration is classified. It stays in the Durable Object if it escalates the window, applies a delay, needs to give the attempt back on a validation error, or is marked strict. Everything else goes to the native binding, counted per data center.

The strict marking is explicit and reviewed: login, MFA, transaction PIN, money leaving the account, refunds, payouts, and webhooks. Those limits traded speed for accuracy on purpose.

### Parallel where the object stays

In the limits that stayed in the object, a single request used to check several keys (the route's global one and the scoped ones) one after the other. I switched to checking the keys in parallel. The latency became that of the slowest key, not the sum.

### A single list, pinned by a test

The native binding limits must also be declared in the Worker's configuration. So the two lists do not diverge, it is declared once in code, the binding type derives from it, and a parity test checks both environments' configuration against that list. Forgetting a limit fails in CI, not in production.

## An example

The classification, in short form:

```ts
type LimitConfig = {
  name: string;
  escalatesWindow?: boolean;
  delayMs?: number;
  refundOnValidationError?: boolean;
  strict?: boolean;
};

function backendFor(config: LimitConfig): 'durable-object' | 'native-binding' {
  const needsGlobalAccuracy =
    config.strict || config.escalatesWindow || config.delayMs !== undefined || config.refundOnValidationError;
  return needsGlobalAccuracy ? 'durable-object' : 'native-binding';
}

backendFor({ name: 'login', escalatesWindow: true, strict: true }); // 'durable-object'
backendFor({ name: 'pix-out', strict: true }); // 'durable-object'
backendFor({ name: 'list-appointments' }); // 'native-binding'
```

And the measurements of the first design and the final design, in the same environment:

| Scenario | First design | Final design |
| --- | --- | --- |
| Authenticated request with a warm cache | 335 ms | 45 ms |
| Ten simultaneous calls to the same route, the slowest | 3483 ms | 566 ms |
| Growth per simultaneous call | about 330 ms | no fixed step |

Ten parallel calls to the same route traded a three-and-a-half-second queue for a little over half a second.

## Result

The floor of every authenticated request went from 335 ms to 45 ms, and simultaneous calls to the same route no longer queue. The limits that protect login, MFA, PIN, and money stay exact, in the Durable Object, without paying for the queue of the others.

## What I take from it

A Durable Object is a named queue. That is a virtue when the queue is what you want, like counting password attempts, and a bottleneck when the key gathers everyone's traffic in one place. Before optimizing the database or the cache, it is worth measuring what runs before the handler: the fixed cost of every request tends to live in the middleware nobody remembers exists.
