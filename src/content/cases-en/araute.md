---
title: Araute
role: Tech Lead and Software Engineer
period: Jul 2026 to present
summary: "A payments platform can't charge, credit or issue an invoice twice. I'm building Araute end to end, from the API to the dashboard and the SDK, so every merchant balance can be explained entry by entry."
order: 2
links:
  - href: https://www.araute.com
    label: Araute website
  - href: https://docs.araute.com
    label: Public documentation
  - href: https://app.araute.com
    label: Merchant dashboard
stack: [TypeScript, Hono, Kysely, Zod, PostgreSQL, Hyperdrive, Cloudflare Workers, Queues, Cron, Durable Objects, Containers, OpenAPI, TanStack Start, React, Tailwind CSS, Vitest, Playwright]
resume:
  company: Araute
  title: Tech Lead and Software Engineer
  location: Remote
  start: 2026-07
  sideProject: true
  order: 2
  bullets:
    - Built the public payments API (Pix, Pix Automático, boleto, cards, subscriptions and links) with Hono, Kysely and PostgreSQL on Cloudflare Workers, integrated with Woovi, with an OpenAPI contract and Problem Details errors.
    - Modeled money in a double entry ledger, with outbox based webhooks and periodic reconciliation against providers.
    - Implemented NFS-e invoicing with isolated custody of the A1 certificate and mTLS through a dedicated container, plus the merchant dashboard and the @araute/js SDK.
---

## Context

Araute is a payments platform for merchants. A merchant integrates an API and receives payments through Pix (Brazil's instant payment system), Pix Automático (Pix recurring debit), boleto (Brazilian bank slip) and card, creates payment links and subscriptions and issues service invoices (NFS-e, the Brazilian electronic service invoice). Because the product moves money, most of the work is making sure nothing is charged, credited or issued twice and that any balance can be reconstructed later, entry by entry.

## My role

I'm Araute's tech lead and software engineer. I define the architecture and the boundaries between services, make the technical decisions and write the trade-offs down, review what gets merged and write code end to end: the API (Hono on Cloudflare Workers, with PostgreSQL accessed through Hyperdrive), the merchant dashboard, the operations dashboard, the public documentation and the browser SDK.

## Architecture at a glance

- **Public API:** Hono and Kysely on Workers, organized as one module per resource, with Queues and Cron for asynchronous work. It validates input with Zod and generates the OpenAPI contract from the same schemas.
- **Fiscal custody:** a service with no public route, reachable only through the API, that stores merchants' digital certificates and signs invoices. The client-certificate connection (mTLS) to the issuing authority goes through a dedicated container.
- **Merchant dashboard:** TanStack Start with React, with types generated from OpenAPI.
- **Operations dashboard:** the team's internal interface, protected at the edge and authorized again in the API.
- **SDK (`@araute/js`):** an open-source package that mounts the card field of the transparent checkout in the buyer's browser, so the card number never goes through the merchant's servers.
- **Documentation and website:** the public site and the documentation for integrators.
- **Design system:** a component package shared by both dashboards.

The API talks to payment providers through adapters that translate everything into internal events. Money is recorded in a double-entry ledger, and a periodic reconciliation checks what the provider says against what the ledger records.

## Architecture decisions

- **One module per resource, with boundaries checked at build time.** Each resource has its own module, and an import-graph rule breaks the build when a zone imports something it shouldn't. The same tool let me merge fiscal services that used to be separated by deploy without losing the isolation between them.
- **Side effects only after the commit.** Background work triggered inside a transaction is discarded if it rolls back, and the webhooks sent to the merchant come from an outbox written in the same transaction that changes the state.
- **Errors in Problem Details format (RFC 7807) with a stable `code`.** The `code` is the contract with integrators, every error carries a request trace identifier, and the provider's name never appears in the title or the detail.
- **OpenAPI as the contract.** Documentation, dashboard types and test data derive from the specification, and CI blocks any divergence between the schemas in code and the published file.
- **Tests in a real timezone.** The suite runs in `America/Sao_Paulo` on purpose, because in UTC date bugs stay invisible.
- **Security trade-off written down.** When I replaced a per-deploy separation with an import rule in fiscal custody, I recorded what the new setup no longer covers and which control compensates, so the decision can be revisited.
