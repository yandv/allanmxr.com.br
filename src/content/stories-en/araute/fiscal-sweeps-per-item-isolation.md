---
title: Fiscal jobs where one invoice with bad data fails on its own
summary: "In a periodic job over a list, a single invoice with unexpected data can't stop the others or leave a database connection stuck. I made each item fail on its own and get logged for investigation, and the drains run in sequence so the pool always comes back whole."
project: araute
order: 11
tags: [Cron, Cloudflare Workers, PostgreSQL, Resilience, NFS-e]
---

Araute's fiscal side has a set of jobs that run on their own, periodically, through Cloudflare Workers Cron. They check pending invoices with the issuing authority, resume work that got stuck, recover expired reservations, redo automatic retries and assemble RPS batches per establishment (an RPS is the provisional service receipt that some municipalities still require in batches before it becomes an invoice). On a normal day, nobody looks at them, which is exactly why their failure path has to be thought through up front: imagine a single invoice with unexpected data preventing all the others from moving.

## The problem

Each sweep processes a list of items: invoices to check, establishments with a batch to assemble. Reviewing the failure path of the first version, I found two weaknesses that went together.

The first: an item whose own data caused an exception would abort the entire sweep. And since the sweeps ran one after another within the same Cron trigger, the ones later in the sequence wouldn't run either. One bad invoice at the head of the queue would block the check of all the others and also prevent batches from being assembled.

The second: when a drain failed, database pool connections would be left unreturned.

And the effect would repeat. On every run, the same bad item would sit in the same spot in the queue and stop everything again.

## Why it wasn't trivial

Neither failure shows up on the happy path. With well-formed data, the loop processes everything and the pool stays clean. The problem only appears when one specific item has data nobody anticipated, and that item can take a while to show up.

One item's error is information about that item, not about the batch. But the first version's loop treated the batch as a unit: the first `throw` left everything and bubbled up to the Cron handler.

Concurrency made it worse. The drains were fired in parallel with `Promise.all`, each holding its own connection. `Promise.all` rejects as soon as the first promise fails, but it doesn't cancel the others. They keep running, with open connections, after the handler has already given up. In Workers, work left over after the invocation ends isn't guaranteed to finish, so the connection could simply never return to the pool.

## The solution

### Per-item isolation

Each item in the loop got its own `try/catch`. The error is logged with structured context, the document or establishment ID, never customer data, and the loop moves on to the next one.

The sweep's return value changed too. In the first version, it returned the list length, as if everything had gone fine. Now it returns how many items were actually processed. That way the run's metric shows the difference between "there were 40 items" and "I processed 39".

Batch assembly followed the same rule: each group per establishment is assembled inside its own `try/catch`. An establishment with an incomplete registration doesn't block the others' batches.

### Sequential drains

I replaced `Promise.all` with one `await` after another, both in the fiscal jobs and in the Cron metrics reports. Each drain finishes, and returns its connection, before the next one starts. A failure leaves no connection dangling.

I lost parallelism, and accepted the trade on purpose. The sweeps run in the background, with a bounded batch, and nobody waits for them in real time. A few extra seconds per run cost less than a pool that leaks when something goes wrong.

### Test the failure path

I added a test that forces a fiscal drain to fail and checks that the run moves on to the next ones. The error path is now tested the way the happy path always was.

## An example

In the first version, the check loop looked like this:

```ts
async function reconcileDue(docs: DueDocument[]): Promise<number> {
  for (const doc of docs) {
    await reconcileOne(doc.id) // a throw here aborts the loop and the whole run
  }
  return docs.length // counts even what wasn't processed
}

async function runFiscalSweeps() {
  await Promise.all([reconcileSweep(), retrySweep(), buildRpsBatches()])
}
```

In the final version:

```ts
async function reconcileDue(docs: DueDocument[]): Promise<number> {
  let done = 0
  for (const doc of docs) {
    try {
      await reconcileOne(doc.id)
      done += 1
    } catch (error) {
      log.error('fiscal reconciliation failed', { documentId: doc.id, error: String(error) })
    }
  }
  return done
}

async function runFiscalSweeps() {
  await reconcileSweep()
  await retrySweep()
  await buildRpsBatches()
}
```

In practice, a run with 40 pending invoices, where invoice 7 has a municipality code that doesn't exist in the table:

| Item | First version | Final version |
| --- | --- | --- |
| Invoices 1 to 6 | checked | checked |
| Invoice 7 | exception, sweep aborted | error logged with the ID |
| Invoices 8 to 40 | don't run | checked |
| RPS batches | don't run | assembled |
| Run return value | error | 39 processed |
| Next run | same blockage | only invoice 7 stays pending |

Invoice 7 still has a problem, and should stay visible until someone fixes the data. The difference is that it became an item with an alert, not the reason the rest of the queue stops.

## Result

Bad data is a logged item, with the right identifier to investigate, not a blockage of the whole run. One sweep doesn't keep the following ones from running, and the pool doesn't leak connections on the failure path. The processed count per run is also honest, which made the difference visible between "the queue is empty" and "the queue is stuck".

## What I take from it

For a periodic job over a list, the first question is whether one item's failure should stop the others. Almost never. The second is whether parallelism is worth its cost on the failure path, especially when the items compete for a shared resource like a connection pool. `Promise.all` is great for the happy case and treacherous for the rest, because it gives up fast and leaves the others' work loose.
