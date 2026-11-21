---
title: "A cache layer on top of the Cache API: hot reads without losing the type"
summary: "I designed the API's cache layer on top of Cloudflare's Cache API, with versioned keys and background refresh. While exercising billing, the limit of storing objects as JSON showed up: dates came back as text. The final version preserves the type on the way in and out."
project: salte
order: 13
tags: [Cache, Cloudflare Workers, TypeScript, JSON, Stale-while-revalidate]
---

A clinic owner opens the ERP, and the first screen asks who she is, which clinics she belongs to, what permissions she has in each, and where the subscription stands. These are small reads, repeated on almost every request, and each one costs a trip to Postgres. In a Worker, where every millisecond before the handler counts, those reads called for a cache. The question was how to build a cache that answered fast, never served data from one environment to another, and returned exactly what the database would return.

## The problem

The API runs on Cloudflare Workers, and the native way to store responses close to the user is the Cache API, which stores `Response` objects by URL in each data center. It knows nothing about domain objects: it stores bytes and returns bytes. To use it as an application cache, I needed a layer that turned "user 42 of this clinic" into a key, handled expiration, and hid serialization from the rest of the code.

Three requirements guided the design: keys that never collide across services and environments; a hot read that does not make the user wait for the value to be refreshed; and an honest type contract, in which data read from the cache has the same shape as data read from the database.

## Why it wasn't trivial

The Cache API has no per-item expiration that the application can query, and no bulk invalidation. Changing the format of an entry requires a way to abandon the old ones without deleting them one by one.

Refreshing in the background also has a platform detail. In a Worker, work that continues after the response must be registered with `waitUntil`, or the runtime may kill it midway.

And JSON has no date type. `JSON.stringify` turns a `Date` into ISO text, and the read returns text. To make it worse, TypeScript does not notice: the function that reads from the cache declares the return type, and the compiler believes it.

## The solution

### Keys as URLs in their own namespace

Each cache instance is identified by service, environment, and version, and each entry's key becomes an internal URL on a domain that serves only as a namespace. Production, staging, and development coexist in the same Worker without colliding. Bumping the version abandons all the old entries at once, without deleting anything: they simply stop being looked up.

Each entry stores the value, the expiration instant, and the effective TTL, clamped between one second and seven days, with five minutes as the default.

### Always warm

The main read takes a key and a function that fetches from the database. With "always warm" mode on, when more than half of the TTL has passed, the cached value returns immediately and a refresh runs in the background, registered with `waitUntil`, so the next request finds a fresh entry. On an empty cache, the write also goes to the background: the response goes out as soon as the database answers. It is the stale-while-revalidate pattern, applied to domain objects. Writes invalidate the keys they affect, such as the user's sessions on login, renewal, and logout.

### The limit I found: dates that turned into text

The first version serialized with `JSON.stringify` and read with `response.json()`. While exercising payment recovery after 3D Secure, the subscription cycle advance received an invoice that came from the cache, and the period end date was a string. Read from the database, it was a `Date`. The result depended on whether the read hit the cache or not, the worst kind of behavior to debug.

I solved it in two layers. In billing, the date conversion now also accepts a value typed as `Date` that is a string at runtime, and the cycle advance functions convert the boundary date on entry. In the cache layer, which is the cause, I made the type survive the trip.

### An envelope for every Date

On write, a replacer swaps each `Date` for an envelope with a type tag and the ISO value. There is a catch: `JSON.stringify` calls the date's `toJSON` before handing the value to the replacer, so the replacer reads the original from `this[key]`. On read, a reviver recognizes the envelope and rebuilds the `Date`. A corrupted body, or one in an unexpected format, counts as an empty cache, never as an error. And I bumped the default key version, so the old format is abandoned instead of being read by the new one.

The test suite's cache double also started storing the body as text, exactly as the Cache API delivers it. A double that stored the ready-made object would hide precisely the type loss.

## An example

The type loss, reduced:

```ts
const invoice = { id: 'inv_1', periodEndsAt: new Date('2026-06-30T23:59:59Z') };
const naive = JSON.parse(JSON.stringify(invoice));
typeof naive.periodEndsAt; // 'string': getTime() doesn't exist here
```

The envelope:

```ts
type DateEnvelope = { __t: 'Date'; v: string };

function replacer(this: Record<string, unknown>, key: string, value: unknown) {
  // toJSON already ran: `value` is a string, the original Date is still in this[key]
  const raw = this[key];
  return raw instanceof Date ? { __t: 'Date', v: raw.toISOString() } : value;
}

function reviver(_key: string, value: unknown) {
  const isEnvelope =
    typeof value === 'object' && value !== null && '__t' in value && value.__t === 'Date' && 'v' in value;
  return isEnvelope ? new Date((value as DateEnvelope).v) : value;
}

const roundTrip = JSON.parse(JSON.stringify(invoice, replacer), reviver);
roundTrip.periodEndsAt instanceof Date; // true
```

The cast to `DateEnvelope` shortens the example. In the real code, a type-checking function also verifies that `v` is a string.

And the timeline of a hot read, with a 60-second TTL:

```text
t=0 s    empty cache: fetch from the database, respond, write in the background
t=20 s   cache with 1/3 of the TTL spent: respond from the cache
t=40 s   more than half spent: respond from the cache and refresh in the background
t=41 s   refresh writes the new value, expiring at t=101 s
```

## Result

The ERP's repeated reads, such as account, sessions, permissions, and subscription, answer from the cache without waiting for a refresh, and different environments never share entries. A database read and a cache read return the same type, and any module that stores dates got this without changing a line. The suite reproduces the real Cache API behavior, with tests for the date round trip, a corrupted body, and the old format.

## What I take from it

A cache is a serialization boundary, and every serialization boundary loses type unless someone decides otherwise. Versioning the keys from day one is what made it cheap to change the format later. And a test double that is "smarter" than the real dependency hides exactly the limits the test should reveal.
