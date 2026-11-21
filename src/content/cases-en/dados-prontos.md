---
title: Dados Prontos
role: Creator
period: '2026'
summary: "Public data in Brazil exists, but it's locked in slow sites with no API, and people end up copying it by hand. I maintain 12 scrapers on the Apify Store that deliver this data clean, from auctions to public procurement and official gazettes."
order: 6
stack: [Python, Apify SDK, curl_cffi, httpx, Playwright, Pydantic, Astro, Tailwind CSS, Cloudflare Workers]
links:
  - href: https://dados.allanmxr.com.br
    label: See the storefront
  - href: https://apify.com/allanmxr
    label: Apify profile
resume:
  summary: 12 scrapers published on the Apify Store that deliver clean public data as JSON, from auctions to PNCP public tenders and official gazettes. Python, Playwright and Pydantic.
  order: 2
---

## The problem

Public data in Brazil exists, but it's locked in slow, paginated sites with no API, each in its own format. Anyone who needs to monitor public procurement, auctions or official gazettes ends up copying by hand. I turned this into twelve Apify Store actors: the customer sets filters and gets a flat JSON dataset.

## Challenges and how I solved them

### Sites with no API: finding the internal endpoint

Almost no source has a documented API. For each one, I open DevTools, see what the site itself calls and reproduce the call. On PNCP (Brazil's national public procurement portal), I found the internal search, its parameters (multiple values separated by `|`) and that `page * page_size` can't exceed 10,000, otherwise the API returns 400. In other cases the data comes as JSON embedded in the page (`__NEXT_DATA__`) or in an official CSV list, like Caixa's. I always prefer internal JSON over HTML. The result: fewer requests and less breakage when the layout changes.

### An HTTP client with a ladder of steps

Each source reacts differently. I built a client per actor that starts at the cheapest step and only climbs when the previous one fails: a plain HTTP request, then the same request through Apify Proxy, and a headless browser only when the page depends on JavaScript. I measured the minimum step for each source and documented it. When the challenge requires human interaction, the source stops and the run status says so. I don't try to solve CAPTCHAs. For most sources the minimum step is the first one, and that keeps the cost per run in the range of cents.

### Respecting limits: pacing, retries and backoff

429 and 5xx responses are retried with backoff and jitter. `Retry-After` is honored, with a cap so a slow source can't stall the run. When the retries of several requests woke up together, they produced a burst; I switched to a single shared pause per source. Each source has its own pace (Caixa runs on three fixed identities, about one request per second each). A failure in one source stays isolated: the others carry on and the run summary records what happened.

### Pagination with caps and duplicates

Each site's caps become rules in the code. Superbid's API repeated and skipped offers until I fixed `orderBy=id:asc` (about 25% of lots were missing). Reclame Aqui limits each query to 500 items, so I plan the collection from the site's counts and split the search by status, state and issue until each slice fits. OLX repeats page 100 for any larger offset, and PNCP blows past 10,000, so the search is sliced by state and procurement type. One lot broke Mega Leilões' renderer and the page always returned 500; I re-read with a different ordering and the union recovers the neighbors (353 of 359 lots in SP, against 311).

### Twelve formats, one flat schema

Each actor merges several sources into one item: ten vehicle auctioneers, four property portals, four used-car sources. I normalize price to a number, dates to ISO with the Brasília timezone, amenities to a single vocabulary and deduplicate by source identifier. For Chile, Colombia and Argentina, the local value gets a dollar field using the rate from two providers (one as a fallback) and the quote date. The dataset schema has a title and an example on every field, so AI agents can understand the output.

### Enriching with FIPE

To show the discount on auction and used cars, I matched each listing to the FIPE table (Brazil's reference vehicle price index). The match is built from brand by tokens, model year code, hard rules on engine and transmission, and a score combining Jaccard and `difflib`. Results are cached by path, because the API without a token has a daily cap. Adjustments the tests demanded: "turbo" has to count as a distinctive term, and trims such as "premier" need their own mapping.

### Monitor mode: only what's new

Procurement and official gazette monitors keep state between runs in a named key-value store. The procurement monitor stores the identifiers already seen for 180 days, and only what was actually delivered enters the state. The gazette monitor re-reads two days before the watermark, and uses a 24 h overlap on Querido Diário to catch editions indexed late. State is saved after every billed batch, so a crash never charges twice.

### A custom index for 74 million CNPJs

Company search APIs filter very little. I generated an index from the Receita's open data (CNPJ is the Brazilian company registry number): 74.2 million establishments in about 11 thousand compressed keys, with only filter fields. The search filters before fetching the detail, so the customer only pays for what matches. A monthly GitHub Actions workflow rebuilds the index and uploads only the keys that changed, with a hash manifest written last, so the actor never mixes two snapshots.

### Tests and measured cost

Each actor has an E2E script with screenshots and real numbers, parsing tests with no network and a check against the total the site shows. I measured the cost per thousand items on the platform (usually between 0.01 and 0.02 dollars per thousand items) and used it to calibrate memory and pricing. A load test of mine got an IP banned for an hour; the actor fell back to the next source on its own, and since then I don't run load tests against a third-party API.

## Architecture decisions

- **One actor per theme, several sources per actor.** The customer wants "car auctions", not "Copart". A single schema is worth more than one scraper per site.
- **Primary sources and public data only.** I removed a competing aggregator over the risk of unfair competition. I don't collect CPF (Brazilian individual taxpayer number), debtor names or the names of private individuals, and I mask CPF in free text.
- **Filter before charging.** Pay per event for each delivered item, with `maxItems` respected and the quota split among sources, returned when a source runs dry.
- **Diagnostics on every run.** `REQUEST_LOG` and `RUN_SUMMARY` record status, block type and time per host, which makes it visible when a source has changed.
- **Static storefront.** An Astro and Tailwind site on Cloudflare Workers, with an auction calculator and a list of Caixa properties.
