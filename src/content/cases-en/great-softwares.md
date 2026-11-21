---
title: Great Softwares
role: Senior Software Engineer
period: Feb 2026 to present
summary: "Great's three products share login, billing and domains, so a bug in one reaches the others. I build all three end to end: the Great Pages builder, the Great Apps account and billing platform, and the Great Domains registrar."
order: 1
links:
  - href: https://greatsoftwares.com.br
    label: Great Softwares website
  - href: https://greatpages.com.br
    label: Great Pages
  - href: https://greatdomain.com.br
    label: Great Domains
stack: [TypeScript, Hono, Cloudflare Workers, Durable Objects, WebSocket, Queues, Workflows, R2, PostgreSQL, Kysely, Zod, EPP, MCP, Next.js, React, Tailwind CSS, OpenNext, Vitest]
resume:
  company: Great Softwares
  title: Senior Software Engineer
  location: Barueri, Brazil
  start: 2026-02
  order: 1
  bullets:
    - Built the company's three products end to end (Great Pages, Great Apps and Great Domains), from the Hono API on Cloudflare Workers and PostgreSQL to the Next.js visual editor.
    - Developed real time collaborative editing for the page editor with Durable Objects and WebSocket, keeping state in SQLite at the edge and measuring write cost in tests.
    - Created an MCP server that lets AI agents control pages, blogs, quizzes and slides, with OAuth, scopes and server verified confirmation for writes.
    - Implemented the Great Domains registrar from scratch, with OpenSRS and .br domains over EPP at Registro.br, and orders protected by idempotency and conditional state transitions.
    - Integrated billing with Pix Automático, boleto, cards and affiliates using Stripe, Woovi and Vindi, reconciling mandates and invoices.
---

## Context

Great has three products that talk to each other. **Great Pages** is a builder for pages, blogs, quizzes, presentations and imported sites, with a visual editor, AI editing and publishing on a custom domain. **Great Apps** is the account and billing platform the products share: login, plans, subscriptions and credits. **Great Domains** is the domain registrar. Everything runs at the Cloudflare edge, with Hono APIs, PostgreSQL and a Next.js front end.

## My role

I joined in February 2026 as a senior software engineer with a fullstack scope and work across all three products, from the API to the visual editor. On Great Pages, my most notable areas were real-time collaborative editing, the MCP server, the editor's AI editing and chat, site import and cloning, publishing with a custom domain and SSL, and the Next.js front end on Cloudflare. On Great Domains and Great Apps, domain registration, orders and billing. The most interesting problems I solved became the posts below.

## Architecture at a glance

- **Editor** in Next.js 16 with OpenNext on Workers. It talks to the API through Route Handlers (reads) and Server Actions (mutations), and to the collaboration room over WebSocket.
- **Great Pages API** on Workers: pages, projects, domains, publishing, design systems, A/B experiments and site import. It persists to PostgreSQL and publishes artifacts to R2.
- **Collaboration service**: one Durable Object per room (a page plus an A/B test variant) and one per theme, with state in the object's own SQLite and writes back to the API in the background.
- **AI service** for the editor: agent chat and element editing through semantic operations, billed in credits.
- **MCP server**: a thin facade that exposes the platform to AI agents, with OAuth, scopes and confirmation on writes.
- **Supporting services**: a site cloner with a remote browser, queue-driven page thumbnails, R2 storage, SSL for custom domains and previews served on an isolated domain.
- **Great Apps and Great Domains**: their own Hono APIs, with PostgreSQL, queues and integrations with payment and domain registration providers.
- **Shared libraries** across the front ends for authentication, account and billing components, and typed access to the APIs.

## Architecture decisions

- **State in the right place.** The collaboration room lives in the Durable Object's SQLite, with no external database on the hot path. Since the platform bills per row written, write cost is measured by a test, with a cap per operation.
- **Authoritative server and small operations.** Collaboration, theme editing and AI editing send idempotent operations instead of whole documents. A list of changes merges, and two editors stop overwriting each other.
- **Closed boundary where the caller isn't trusted.** MCP and AI editing use closed lists, a contract hash and server-verified confirmation, because a tool argument is text that has passed through a model.
- **Idempotency by key and by conditional transition**, instead of locks, in billing and registration flows. A lock cached at the edge is only valid in the data center where it was written.
- **Hexagonal architecture** (ports and adapters) in the new APIs, with tests that enforce the boundaries. The domain runs on Node with no I/O, and Durable Object behavior is validated in workerd, the real Workers runtime.
- **A stable, documented error contract**, checked by a test on both sides, and minimal exposure: secrets kept out of the repository and responses that return only the necessary fields.
