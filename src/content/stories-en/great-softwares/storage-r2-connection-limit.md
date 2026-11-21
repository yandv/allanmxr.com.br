---
title: Finding the Worker's connection ceiling by measuring, so the copy fits the deadline
summary: "Copying the images of a page with over a hundred files, one request per file, used almost the whole 30-second export deadline. I measured the Worker's connection limit, reorganized the copy into batches and it now finishes in a few seconds."
project: great-softwares
order: 10
tags: [Cloudflare R2, Cloudflare Workers, Concurrency, waitUntil, Streaming]
---

Exporting a Great Pages page requires copying each image to a new address in storage. On an image-heavy page, measuring the per-file path, that step alone used almost the 30 seconds the export's HTTP client waits before giving up. Imagine the progress bar moving slowly and stalling near the end with a timeout error: that was what the new copy had to avoid.

## The problem

The images live in R2, Cloudflare's object storage. A Worker owns the bucket and exposes upload, copy and delete operations. The export asked for one copy per HTTP request to that Worker, one per file. On a page with a little over a hundred images, the copy ran at under five files per second, and parallelizing more on the caller's side changed nothing.

There was a second risk in the same service. An R2 write that was only awaited could be interrupted midway if the client disconnected, with no exception and no log, and a published file might simply not exist.

## Why it wasn't trivial

- **A Worker keeps at most six requests waiting for response headers at the same time.** The storage service only responded when the transfer finished, so all six slots were occupied. More parallelism on the caller's side only made the queue longer.
- **The R2 binding obeys the same ceiling.** With streaming, the read from the source stays open while the destination writes, so each in-flight copy occupies two connections. Above the limit, the runtime closes the response with a connection limit error.
- **Loading the file into memory doesn't solve it.** A batch of large images hits a Worker's 128 MB of memory.
- **"Await" doesn't guarantee the write finishes.** When the client disconnects, the platform can end the invocation, and the in-flight promise dies with it.
- **The per-file copy wasn't strict.** It responded success even when the source didn't exist or when something failed in the middle of the loop. Moved to a queue, that response would confirm copies that never happened.

## The solution

### Copy where the bucket is

The copy operation now receives a list of source and destination pairs and runs them through the bindings, inside the Worker that owns the bucket. The per-file HTTP transport goes away. The copy passes the object's body straight from one side to the other as a stream, without materializing the file in memory.

### Finding the number by measuring

The documentation gave the hint, but didn't say how the limit behaved with streaming copies. So I measured in staging, against a real test page, varying how many copies ran at the same time. The result is in the example below. I fixed it at six at a time and left the measurement written as a comment next to the constant, so nobody raises the number thinking it's too conservative.

### A second pass for whatever fails

Whatever fails in the first round is retried one at a time, because the failure mode is connection pressure and the same copy on its own goes through. A nonexistent source isn't retried, because trying again changes nothing. The client splits the copies into invocations of 25 items.

### Every write handed to `waitUntil`

Upload, copy and delete are now registered with `waitUntil`, the mechanism that asks the runtime to keep working after the response. The happy path returns the same promise, and the caller keeps awaiting as before. The difference is that, if the client disconnects, the write still has up to 30 seconds to finish.

### An honest copy and an existence check

The queue-based copy became strict: a missing source or a failure in the middle of the loop becomes an error with a retry, because the source may be another copy that hasn't arrived yet. I also created an operation that, given a batch of keys, says which ones exist. It uses a per-key lookup, not a prefix listing, because `foto.png` is a prefix of `foto.png.bak` and would give a false positive. With that, whoever produces a link checks that the file exists before publishing it.

## An example

The measurement that set the limit, with more than a hundred images per round:

| Simultaneous copies | Result |
| --- | --- |
| 25 | about half failed |
| 15 | about a fifth failed |
| 10 | intermittent failures |
| 6 | all copies, in every round |

And the shape of the loop, in a minimal version:

```ts
const PARALLEL_COPIES = 6; // each streaming copy occupies two connections

async function copyMany(bucket: R2Bucket, pairs: CopyPair[]) {
  const failed: CopyPair[] = [];

  for (let i = 0; i < pairs.length; i += PARALLEL_COPIES) {
    const chunk = pairs.slice(i, i + PARALLEL_COPIES);
    const results = await Promise.allSettled(chunk.map((pair) => copyOne(bucket, pair)));
    results.forEach((result, index) => {
      if (result.status === 'rejected') failed.push(chunk[index]);
    });
  }

  // A failure from connection pressure goes away when the copy runs alone.
  for (const pair of failed) await copyOne(bucket, pair);
}

async function copyOne(bucket: R2Bucket, { from, to }: CopyPair) {
  const source = await bucket.get(from);
  if (!source) throw new SourceMissingError(from);
  await bucket.put(to, source.body, { httpMetadata: source.httpMetadata });
}
```

In the real version, a missing source leaves the second pass and is reported directly as a failure.

## Result

The copy that took almost 30 seconds now finishes in a few seconds, with a handful of invocations instead of one request per file, and the export fits comfortably within the client's deadline. R2 writes survive the requester's disconnection, and the queue-based copy reports what really happened.

## What I take from it

When a platform limit is a number, find the number by measuring, in your own usage pattern, and leave the measurement written next to the code. And don't treat `await` as a guarantee that a write finishes: if the data matters, hand the write to the runtime with `waitUntil`.
