---
title: Dependency injection in a Worker, with no framework and no container at boot
summary: "Wiring services by hand at every call site spread repeated code across the API, and an injection framework would weigh on cold start and trip over cycles between services. I built a per-request container, lazy and typed, that follows the switch between connection and transaction."
project: salte
order: 16
tags: [Dependency injection, Cloudflare Workers, TypeScript, Architecture, Knex]
---

A new developer opens Salte's charges service to understand how an invoice is paid. Before reaching the rule, they wade through a dozen lines that only build other services: invoices, subscriptions, notifications, each with the request context passed by hand. In another file, the same constructions repeat. And passing the wrong context at any one of those points was enough for a service to write outside the request's transaction. That was the daily cost of not having a single way to get a service.

## The problem

Salte's API is a large ERP, written in Hono on Cloudflare Workers, with one service per domain: subscriptions, charges, invoices, scheduling, medical records, finance. Services call each other all the time. The way to get one was a factory called at every point of use, taking the class and the context. In just the five modules that used this pattern the most, there were hundreds of calls.

That had three costs. Repetition, because each method rebuilt what it needed. Waste, because the same service was built several times within one request. And risk, because the context carries the database connection, and in Salte that connection changes in the middle of the request.

## Why it wasn't trivial

The textbook answer is a dependency injection framework. They usually rely on reflection and decorators, which add bundle weight and boot work. In a Worker, the isolate's startup time is part of the user's latency, and the goal was to keep that cost near zero.

The service graph is also full of cycles. The subscriptions service calls charges, which calls subscriptions back. Constructor injection only solves that with lazy proxies, which complicate debugging.

And there was the transaction. Write routes run inside a middleware that opens a transaction and swaps the context's connection for it. After the commit, the connection goes back to the pool one, and tasks that run after the commit need that, not the already closed transaction. A container that held on to the wrong connection would break one of the two phases.

## The solution

### One container per request, resolved on demand

Each request has a container that holds the service and repository instances already built. Nothing is built at boot. A service is only created when someone asks for it for the first time in that request, and subsequent calls get the same instance.

Cycles resolve themselves: constructing a service never constructs another, only calling a method does, and by the time the method runs the instance already exists.

### The key is the context and connection pair

The container is indexed by the request context and the current database connection, together. Both halves are necessary. Context alone would reuse, after the commit, services tied to the closed transaction, and the post-commit task would fail with "transaction already completed". Connection alone would mix different requests in the test suite, where several requests share one transaction, and one's cache would leak into the other.

The connection is read from the context at resolution time, never captured earlier. During the handler, the container resolves over the transaction. After the commit, over the pool.

### Typed fields, generated from a registry

To make usage feel natural, a script generates a registry from all the service files, linking each class to a camelCase name. At boot, that registry installs a lazy getter per name on the services' base class prototype, and a TypeScript interface merge gives each field its type. Inside any service, you just write `this.invoicesService.findById(...)`. Outside them, controllers, jobs and webhook handlers use a short function that takes the context and the class.

Forgetting to regenerate the registry when creating a service breaks CI in its own step, and a local test points out which service was left out.

### Rules written down together

Two rules got documented. A service doesn't keep mutable state in a field, because there is now one instance per request and phase. And inside a savepoint opened by hand, which doesn't swap the context's connection, you don't resolve services through the container: it would hand out repositories from the outer transaction.

## An example

The core of the container, reduced to a few lines:

```ts
type Db = object; // pool or transaction
type Ctx = { var: { db: Db } };
type Ctor<T> = new (ctx: Ctx) => T;

const byContext = new WeakMap<Ctx, WeakMap<Db, Map<Ctor<unknown>, unknown>>>();

function use<T>(ctx: Ctx, Service: Ctor<T>): T {
  const db = ctx.var.db; // read now: follows the switch between transaction and pool
  let byDb = byContext.get(ctx);
  if (!byDb) byContext.set(ctx, (byDb = new WeakMap()));
  let instances = byDb.get(db);
  if (!instances) byDb.set(db, (instances = new Map()));
  if (!instances.has(Service)) instances.set(Service, new Service(ctx));
  return instances.get(Service) as T;
}
```

And the timeline of an invoice payment request:

```text
handler (db = transaction T1)
  use(ctx, Charges)  -> builds Charges over T1
  use(ctx, Invoices) -> builds Invoices over T1
  use(ctx, Charges)  -> same instance, no construction
COMMIT, ctx.var.db goes back to pool P
post-commit task (db = P)
  use(ctx, Notifications) -> builds over P, never over the closed T1
```

The `as T` in the example shortens the explanation. In the real code, each service's type comes from the generated registry.

## Result

The whole codebase now has a single way to resolve services. Services inherit from the base class and reach their neighbors as typed fields; controllers, jobs, middlewares and webhook handlers use the same resolution function, and so does the test suite. The migration went out in stages: a pilot in the five most-used modules, then the rest. The old factory became a thin shortcut over the container, so branches in progress didn't break. The code got smaller, with no new dependency and no boot cost.

## What I take from it

Dependency injection is a problem of scope and lifetime, not of library. In a serverless environment, the natural scope is the request, and the right lifetime includes the database phase the code is in. Resolving lazily, at the moment of use, solved cold start, cycles and the transaction all at once.
