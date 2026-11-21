---
title: Turning "MP*PADARIACENTRAL 03/06" into "Padaria Central, Food"
summary: "Bank statements arrive with descriptions like MP*PADARIACENTRAL, and left untreated the spending chart is wrong from the very first visit. I made merchant and category classification run in the background, without duplicating anything."
project: yield
order: 1
tags: [Cloudflare Queues, Classification, PostgreSQL, Text normalization, Dead letter queue]
---

The user connects their bank and, seconds later, Yield receives a year of statement. One line says `MP*PADARIACENTRAL`, another `PAG*PadariaCentral SAO PAULO`, a third `PADARIA CENTRAL 03/06`. To the person it's all the same bakery. To the app, it's three different strings. If I don't solve this, the "how much did I spend on food" chart is wrong from the very first visit, which is exactly when the user decides whether to trust the product.

## The problem

Each transaction needs a known merchant and a category. The description comes from the bank with a payment intermediary prefix, installment number, city, authorization code, with or without accents. And this has to happen for hundreds of transactions at once on the first sync, without delaying the response to the webhook that brought the data.

## Why it wasn't trivial

It's two problems combined. The first is text matching. A pattern that's too short shows up inside another merchant's name, in another category: "BAR" is inside "BARBEARIA" (barbershop). A pattern that's too loose captures what it shouldn't. I needed a way to say "this rule is more specific than that one" without keeping a list of exceptions.

The second is execution. Classifying is CPU plus Postgres queries, and can't run inside the webhook request. It also has to survive a failure midway without duplicating anything and without entering an infinite retry loop.

## The solution

### A single normalization for everything

The bank description and the registered pattern go through the same function: decompose into NFD (the Unicode form that separates the letter from the accent) and strip the accents, lowercase, replace anything that isn't a letter or digit with a space and collapse repeated spaces. It's idempotent, so normalizing already normalized text changes nothing. That sounds like a detail, but it avoids the whole class of bugs where the pattern was saved one way and compared another.

### Aliases with type and weight

Each merchant has several aliases. Each alias has a match type (exact, prefix, contains or regular expression) and an integer weight. Among all aliases that match the description, the highest weight wins; on a tie, the oldest. A specific, heavy alias beats a generic, light one without any special rule.

Regular expressions are restricted to admin-curated patterns, with a size limit and wrapped in `try/catch`, so a bad pattern doesn't take down the whole batch. The user can have their own merchants that shadow the global ones. The detector is a linear scan over the aliases: dozens of merchants against a batch of transactions is cheap, and a smarter structure only pays for itself when the catalog grows a lot.

### A pipeline in fixed order

For each transaction: normalize, detect the merchant, pick the base category (the merchant's, otherwise the one suggested by the aggregator, otherwise "uncategorized"), apply the user's rules in priority order and write the result to a layer separate from the bank data. In that layer, fields the user edited by hand are locked and never overwritten by a reclassification.

### Queue with a job record and a dead letter queue

The sync breaks the new transactions into batches of 300 and publishes one message per batch to Cloudflare Queues. Each message has a control row with a state: pending, running, done or failed. The consumer marks it as running, classifies, writes in blocks of 500 per upsert and completes.

If something fails, the consumer writes the error message and asks for a retry. After three attempts, Cloudflare moves the message to a dead letter queue (DLQ), the queue where messages that exhausted their attempts end up. The same consumer listens to that queue and does only one thing: marks the job as permanently failed, so it shows up on an admin panel instead of spinning forever.

## An example

A fictional catalog and weight-based selection:

```ts
type Alias = { merchant: string; kind: 'exact' | 'prefix' | 'contains'; needle: string; weight: number }

const aliases: Alias[] = [
  { merchant: 'Padaria Central', kind: 'contains', needle: 'padariacentral',  weight: 50 },
  { merchant: 'Padaria Central', kind: 'contains', needle: 'padaria central', weight: 50 },
  { merchant: 'Bar do Zé',       kind: 'prefix',   needle: 'bar ',            weight: 10 },
  { merchant: 'Barbearia Navalha', kind: 'contains', needle: 'barbearia navalha', weight: 80 },
]

const normalize = (s: string) =>
  s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
   .replace(/[^a-z0-9]+/g, ' ').trim()

function detect(description: string): string | null {
  const text = normalize(description)
  const hits = aliases.filter(a =>
    a.kind === 'exact' ? text === a.needle :
    a.kind === 'prefix' ? text.startsWith(a.needle) : text.includes(a.needle))
  hits.sort((x, y) => y.weight - x.weight)
  return hits[0]?.merchant ?? null
}
```

How each description comes out:

| Raw description | Normalized | Merchant |
|---|---|---|
| `MP*PADARIACENTRAL` | `mp padariacentral` | Padaria Central |
| `PADARIA CENTRAL 03/06` | `padaria central 03 06` | Padaria Central |
| `BARBEARIA NAVALHA SP` | `barbearia navalha sp` | Barbearia Navalha |
| `BAR DO ZE` | `bar do ze` | Bar do Zé |

Note that the prefix alias `bar ` (with a space) doesn't match "barbearia", and even if a generic alias did match, the barbershop's weight of 80 would win. Fixing a wrong classification becomes changing a number in a data row, not opening a pull request.

## Result

Classification runs outside the webhook path. Queue delivery is "at least once", but since the upsert uses a stable key per transaction, reprocessing a message doesn't duplicate anything. Permanent failures leave a visible trail instead of vanishing or spinning in a loop. And right after each completed job, the same queue triggers recurring payment detection, which takes advantage of the freshly resolved merchant.

## What I take from it

Retries and a dead letter queue come almost for free when the consumer is idempotent. If it isn't, each retry is a new chance to corrupt data. That's why the right order is to make the write idempotent first and only then put the queue in front.
