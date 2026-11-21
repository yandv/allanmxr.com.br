---
title: "Page thumbnails on a queue: when to capture, when to give up and when not to write"
summary: "When moving thumbnail capture to Cloudflare's remote browser, testing showed blank pictures, pictures of error screens and pages that would never succeed heading to the failure queue. I designed when to capture, when to give up and how to avoid duplicate work, so the failure queue only gets what deserves investigation."
project: great-softwares
order: 9
tags: [Cloudflare Queues, Browser Rendering, Retry, Idempotency, Cloudflare Workers]
---

In the Great Pages gallery, every page, block and template shows up with a thumbnail. For users, that's invisible. For whoever builds it, it's a queue consumer that opens a browser for each item. While testing the switch of the capture engine, blank thumbnails appeared, others showed the "too many requests" error page instead of the content, and pages that would never succeed burned through their retries into the dead-letter queue, where messages that exhausted their retries go.

## The problem

The pipeline is a queue consumer. Each message carries the address of a preview. The consumer opens the preview in a browser, takes the screenshot, uploads the image to storage and writes the reference to the database. The job was to replace a custom Puppeteer session with the ready-made screenshot action of Browser Run, Cloudflare's remote browser service. The swap looked straightforward, but testing showed four failure modes the design had to cover: a blank picture, a picture of an error page, messages burning through all their retries and the same message processed twice.

## Why it wasn't trivial

- **"Page ready" changes from case to case.** A newly created page has no blocks at all. A page made only of custom HTML doesn't have the standard structure either. Waiting for a block selector never finished in those cases.
- **A deterministic failure doesn't improve with retries.** A page that redirects through a script, has an invalid certificate or never renders fails the same on the first and the tenth attempt. With the default policy, the queue would try ten times before giving up.
- **The remote browser leaves from a few shared IPs.** In batches, the captures look like an attack to the rate limit rules of the previews zone itself, and the screenshot comes out as the block page.
- **`Promise.race` doesn't cancel the loser.** When the message's timeout wins, the capture and the write keep running and may finish after the message has already gone back to the queue.
- **User code can hang the page.** On pages with HTML and scripts written by the person, an infinite loop hangs the capture.

## The solution

### A render gate that also filters out errors

The consumer waits for a selector that exists in every page preview, even an empty one, and for a block selector in the case of blocks and templates. The block page and the error pages don't have that selector, so the capture fails instead of delivering a wrong picture. On the preview side, a failure reading the content now returns an error instead of an empty page, so a passing hiccup doesn't become a permanent blank thumbnail.

### Three attempts, then discard

The first two attempts wait for the network to become almost idle. The third settles for the load event, because pages with always-on analytics never go idle. A 429 goes back to the queue respecting `retry-after`, with extra slack. Any other failure goes back until the third attempt, and on the third the message is **acknowledged and discarded**. The delay between attempts is exponential with up to 5 seconds of jitter, so a batch limited together doesn't come back together.

### The house's own traffic recognized by the rules

The previews zone's rate limit rules now recognize the consumer's own captures and leave them out. Without that identification configured, behavior goes back to the default and the rule applies normally.

### Guard against late execution

Processing races against a timeout computed from the capture action's own timeouts, with a margin. Since the timeout doesn't cancel the capture, I wrapped the message in an object that remembers whether it has already been resolved. After each long step, the consumer checks that mark. If the timeout has already returned the message to the queue, the late execution stops there and uploads no image and writes nothing to the database on top of a new delivery.

### Last attempt in safe mode

On the final attempt for a page with user code, the preview URL gets a parameter that turns that code off. If it was the code that hung the earlier attempts, a thumbnail of the page's structure still comes out.

### Less to load

The consumer blocks analytics and ad hosts, refuses heavy media and saves the screenshot as JPEG. The database write requires the account that owns the record in the `UPDATE` condition, which keeps accounts isolated even if a message arrives wrong.

## An example

The guard against late execution, in a minimal version:

```ts
class GuardedMessage {
  private settled = false;
  constructor(private readonly msg: Message<CaptureJob>) {}

  get settledAlready() { return this.settled; }

  retry(delaySeconds: number) {
    if (this.settled) return;
    this.settled = true;
    this.msg.retry({ delaySeconds });
  }

  ack() {
    if (this.settled) return;
    this.settled = true;
    this.msg.ack();
  }
}

async function capture(message: GuardedMessage) {
  const image = await takeScreenshot(message.body.url);
  // The timeout may have fired during the screenshot and requeued the message.
  if (message.settledAlready) return;
  await uploadImage(image);
  if (message.settledAlready) return;
  await saveThumbnailReference(message.body);
  message.ack();
}
```

And how a problematic message goes through the new policy:

| Attempt | Page wait | Result | Action |
| --- | --- | --- | --- |
| 1 | network almost idle | 429 with `retry-after: 20` | goes back in 20 s plus slack |
| 2 | network almost idle | timeout, user script in a loop | goes back with exponential delay and jitter |
| 3 | load, user code off | screenshot of the structure | uploads, writes, acknowledges |

If the third had failed too, the message would have been acknowledged and discarded, without going to the dead-letter queue.

## Result

The dead-letter queue doesn't receive deterministic failures. Empty pages have a thumbnail, the consumer isn't blocked by the house's own rules, and a slow capture doesn't write over a message that has already been redelivered.

## What I take from it

Every queue consumer needs to answer one question: what happens on the last attempt? Retrying a deterministic failure is just an expensive way to postpone the discard. And a timeout with `Promise.race` interrupts nothing, so every write after a long step has to check whether the message is still its own.
