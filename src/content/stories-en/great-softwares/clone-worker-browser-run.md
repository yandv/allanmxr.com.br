---
title: "Porting the page cloner to Workers, where every browser command is a network round trip"
summary: "The cloner that brings in pages from other builders had to move from a dedicated server to Cloudflare without changing anything for its users. I migrated it with the same contract and cut the round trips to the browser until the time became acceptable."
project: great-softwares
order: 5
tags: [Cloudflare Workers, Browser Rendering, Puppeteer, Migration, Performance]
---

Someone who already has a landing page built in another builder wants to move to Great Pages without rebuilding everything. They paste the address, wait a bit and receive the page in the editor: blocks, texts, forms, images, popups and even hover styles. What does this is the cloner, a service that opens the page in a real browser, reads the DOM and translates it into the editor's format. It ran on Node, with Express, Puppeteer and PostgreSQL, in a container outside Cloudflare. My task was to move it to a Worker without changing the contract with whoever calls it.

## The problem

There were two goals. First, equivalence: same routes, same payloads, same result. Second, the page should come out directly in the editor's new format, without going through the old format and a converter afterwards.

## Why it wasn't trivial

- **Thousands of lines of scraping**, with routines per element type and per source builder. Each one reads the DOM its own way.
- **The browser stops being a local process.** On Cloudflare's Browser Rendering, each Chrome DevTools Protocol (CDP) command is a round trip over the network. A loop that reads one element at a time, cheap in a container, turns into minutes.
- **There's a limit on browser launches per second**, with a 429 above it, and one of the source builders answered 403 to the remote browser's default user agent.
- **Background work doesn't survive in a Worker.** In the container, image writes fired without awaiting finished because the process stayed alive after the response. In a Worker, anything that isn't awaited or handed to `waitUntil` simply stops when the response goes out.

## The solution

### Equivalence before optimization

I made a piece-by-piece swap map. Express became the in-house router. The request validator became a custom implementation, which I checked against the original library with 120 thousand random inputs with no difference in result. The `pg` driver became Hyperdrive (Cloudflare's connection pool for external databases), `axios` became `fetch` and the HTTP storage service became a direct R2 binding. The Worker has no public route: it's only called through a service binding.

Each request opens a browser and closes it in the `finally`, before responding. Popups use two isolated contexts, desktop and mobile. The 403 went away when I switched to the user agent of an ordinary Windows Chrome.

Everything that used to run loose is now awaited before the response. I recorded each of those changes in a list of intentional divergences, so nobody mistakes the difference for a regression.

### Cutting round trips

This was most of the work, in two rounds of measurement:

- I placed the Worker close to the remote browser, to lower the latency of each message.
- I replaced loops that asked for a handle per element with a single `evaluate` call per block, which returns buttons, texts, images, forms, videos and sliders in one pass.
- Hover capture now uses two messages per element instead of several.
- I replaced fixed sleeps with condition-based waits: the page is stable when there's no DOM mutation for 500 ms, no finite animation running, fonts loaded and visible images complete. The ceiling stayed the same as before, and unbounded loops got a 10-second cap. These waits run in the Worker and poll the page with short messages, because a background tab throttles `setTimeout` to about 1 second and a wait inside the page itself would blow the deadline.
- I blocked trackers, ad pixels and chat widgets at the network level, with exceptions for what the page needs to render.
- I parallelized only what doesn't change the result: background images 4 at a time and elements 3 at a time, with the final order identical to the sequential one.

### Native output

The document is generated directly in the new format, with the same parser as the API's converter, and the page's design system is created with the same theme hash the API uses, checked against reference values computed by the original code.

## An example

A block with 40 elements, on a network where each CDP message takes about 30 ms round trip. Before, the code read one element at a time:

```ts
// Before: 1 message to list + 3 per element
const handles = await page.$$('[data-block="b1"] > *');
for (const h of handles) {
  const tag = await h.evaluate((el) => el.tagName);
  const text = await h.evaluate((el) => el.textContent);
  const box = await h.boundingBox();
  items.push({ tag, text, box });
}
```

That's 1 + 40 × 3 = 121 messages, about 3.6 seconds of network alone for one block. After, a single call reads everything inside the page and returns a serializable array:

```ts
// After: 1 message per block
const items = await page.evaluate((selector) =>
  Array.from(document.querySelectorAll(selector), (el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, text: el.textContent, box: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }), '[data-block="b1"] > *');
```

One message, about 30 ms. On a page with dozens of blocks, that difference separates a clone that finishes from one that times out.

## Result

In local measurement, cloning a real page took about 57 seconds, hover capture about 3 and popup capture about 21. An end-to-end suite with real pages from the supported builders covers the success, failure and validation contracts, and the API for callers stayed the same.

## What I take from it

With a remote browser, count the round trips before looking at CPU: the latency is in the messages, not in the processing. And when porting a system, keep a written list of intentional divergences. It's what explains tomorrow's behavior when someone compares it with the old one.
