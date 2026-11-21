---
title: Importing a whole site by URL without opening a door to SSRF
summary: "Importing a site by URL makes the server download any address the user chooses, including from the internal network. I blocked those accesses and only accept the copy after opening it in a real browser and seeing that it works."
project: great-softwares
order: 6
tags: [SSRF, Security, Cloudflare Workers, Browser Rendering, Parsing]
---

An agency has a handmade corporate site, in HTML and a bit of React, hosted somewhere they want to leave. On Great Pages, they paste the address and click import. Behind the scenes, my server downloads the HTML, discovers every CSS, script, font and image, stores everything and publishes a copy that should work the same. For the person asking, it's a button. For the person building it, it's a feature that makes the server fetch any URL a user chooses.

## The problem

Great Pages started accepting complete HTML sites, in addition to pages assembled in the editor. Importing by URL had to bring the site in faithfully and, at the same time, not become a tool for reaching the internal network, nor for copying someone who asked not to be copied. Security and fidelity pull in opposite directions.

## Why it wasn't trivial

- **SSRF (Server-Side Request Forgery)**, the attack in which someone makes the server fetch, on their behalf, an address that should be unreachable. The URL can point straight at the private network, or answer with a redirect to it after an innocent first response.
- **Knowing what to download goes far beyond `<img src>`.** Modern sites reference files in `source`, `video`, `srcset`, inside CSS with `url()` and `@import`, and in JavaScript strings that only a browser would resolve.
- **Some sites block automated access** with challenge pages, and others say in `robots.txt` that they don't want bots.
- **Downloading everything doesn't guarantee it works.** Single-page applications break from a hydration error (when the HTML from the server doesn't match what React builds on the client) or from a lazily loaded module that got left behind.
- **Volume and time**: hundreds of files, each of which can be huge or slow.

## The solution

### Manual redirects, revalidated at every hop

The download uses `fetch` with `redirect: "manual"`. Each `Location` goes back through the same check before being followed: invalid URL, private network, known trackers and the platform's own preview zone are blocked. There's a hop ceiling, a byte ceiling (the one declared in `content-length` and the one counted during reading) and a timeout per file.

Following redirects by hand has a side effect: cookies become my problem. I keep one cookie jar per origin and treat `max-age=0` as a deletion, because some sites set a cookie on one hop and require that cookie on the next.

### Discovery by tokenization

HTML goes through an event parser. CSS goes through a tokenizer, and only real `url()` and `@import` count, not similar-looking text inside a comment. JavaScript goes through a language tokenizer, which extracts string literals and template literals without interpolation.

A string that looks like a static file, such as `"img/hero.webp"`, becomes a candidate. If the path is absolute or starts with `./`, resolution is direct. If it's purely relative, it becomes a speculative candidate, tested in more than one folder, with a total ceiling of probes. A probe that fails doesn't bring down the import. That's how the tool started finding media that only the script referenced.

### Respect and blocking

`robots.txt` is read, and a total block becomes a clear refusal. Antibot challenge pages are recognized by title and content, and the message suggests downloading the site's code and using the file import, instead of insisting. Badges and scripts that the origin host injects into the HTML are removed by analyzing the tree and the CSS, not by text search.

### Proving the copy

After the download, the server opens the copy in a remote browser, on a signed preview host, with a fixed viewport. It scrolls the page, records console errors and compares the rendered text with the origin's, requiring a minimum ratio. The copy is rejected if known React hydration errors or dynamic module load failures appear, or if navigation leaves the copy's host, a sign that the site tried to go back to the origin. Internal routes of single-page applications are probed in the same browser, to discover which pages the site actually has.

## An example

Timeline of an import that tries to escape to the internal network (fictional values):

| t | Request | Decision |
|---|---|---|
| 0 ms | `GET https://exemplo-agencia.com.br/` | allowed; 301 response to `/home` with `Set-Cookie: sid=abc` |
| 80 ms | `GET https://exemplo-agencia.com.br/home` with `Cookie: sid=abc` | allowed; 140 KB HTML |
| 300 ms | JS tokenizer finds `"assets/hero.webp"` | speculative candidate, tested in `/assets/` and `/home/assets/` |
| 310 ms | `GET https://exemplo-agencia.com.br/r?to=interno` | 302 response to `http://10.0.0.5/admin` |
| 311 ms | `Location` check | blocked: private network; file marked as unresolved |
| 2.4 s | download finishes within limits | copy assembled in storage |
| 6.0 s | browser opens the copy on the preview host | clean console, rendered text compatible with the origin |
| 6.1 s | verdict | copy accepted |

The point of the example is at 311 ms: the first response was innocent, and the detour only shows up on the second hop. With `redirect: "follow"`, `fetch` would have followed on its own and I would never have seen the internal address.

## Result

Importing by URL refuses what it must not do, explains why in plain language and only accepts a copy that passed a real browser check. Everything runs within declared limits on files, bytes, hops and time. On publishing, the same reasoning holds: a site with client-side routing is checked against the real path where it will live, including a deep route, before the publisher accepts it.

## What I take from it

For any "download this URL", do the redirect by hand and revalidate every hop. For any "copy this", don't trust the download: open the copy and see whether it works.
