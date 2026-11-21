---
title: Salte
role: Tech Lead and Software Engineer
period: Feb 2026 to present
summary: "Salte is an ERP for clinics: scheduling and front desk, patient records and signed documents, finance, professional payouts, a bank account, health insurance billing, inventory, subscription billing and a mobile app, with clinical AI as one more layer. As tech lead, I own the architecture and write code across all of these fronts."
order: 3
links:
  - href: https://salte.app
    label: Salte website
stack: [TypeScript, Hono, Cloudflare Workers, Durable Objects, PostgreSQL, Hyperdrive, D1, R2, Zod, TanStack Start, React, Expo, LLMs, RAG, Evals]
resume:
  company: Salte
  title: Tech Lead and Software Engineer
  location: Remote
  start: 2026-02
  sideProject: true
  order: 3
  bullets:
    - Lead the architecture of a clinic management platform that is multi-tenant per clinic and whitelabel per brand, built with Hono on Cloudflare Workers and PostgreSQL through Hyperdrive, with the same Workers serving several brands by domain.
    - Structured clinic finance on an append-only ledger, with accounts payable and receivable, cash register, professional payouts and a bank account via Woovi with Pix and boleto.
    - Organized health insurance billing into claims and monthly batches reconciled in accounts receivable, plus platform billing with plans, subscriptions, checkout and coupons.
    - Drove the Expo mobile app for iOS and Android on the same API, with MFA sign in, chat with the agents and consultation transcription.
    - Developed the clinical AI, an evidence engine with LLMs and hybrid search that cites its source or abstains, measured by evals, and an agent that operates the clinic's web systems through chat.
---

## Context

Salte is an ERP for clinics. A clinic schedules, receives the patient at the front desk, runs the service queue, sees the patient, records the chart, issues and signs prescriptions and medical certificates, tracks inventory, charges the patient, bills health insurance, pays its professionals and moves money in its own bank account without leaving the system. The team talks through an internal chat, and the mobile app, on iOS and Android, brings MFA sign in, conversations with the agents, consultation transcription and signing of prescriptions and certificates to the phone.

The product is multi-tenant on two levels. Each clinic is an isolated tenant, with permissions per profile and per person. On top of that, it is whitelabel per brand: the same Workers serve several brands, each with its own domain, visual identity and user accounts.

Clinical AI is a layer on top of this ERP: an evidence engine that answers with the source cited, and an agent that operates the system through conversation. It has its own posts, further down. Because Salte handles health data and money, every decision starts from the question "what happens when this fails?".

## My role

I have been Salte's tech lead and software engineer since February 2026. I led, designed and coded the entire ERP: scheduling and front desk, the service queue and call panel, patient charts and signed documents, finance and professional payouts, the bank account, health insurance billing, inventory, platform billing and the mobile app, on top of the clinical AI layer.

I built the foundation of the API: the move from Prisma to Knex, Zod schemas instead of entity classes, public ids in UUIDv7, cookie based authentication with MFA and Google sign in, multi-tenancy per clinic and per brand, the transaction middleware, the cache layer and the per-request service container. I define the architecture and the standards for the API, the web front end and the app, make the technical decisions and write the trade-offs down in each module's documentation, review what gets merged, pair with the team on the most sensitive fronts and write the rules the team and the coding agents follow.

The posts below tell the challenges of each front, from whitelabel by domain to payouts in batches, from the bank account with a transaction PIN to health insurance billing, and, further down, the clinical AI ones: the answer contract with citations, the eval based measurement and the agent's password vault.

## Architecture at a glance

- **ERP API (Hono on Cloudflare Workers, PostgreSQL through Hyperdrive):** one module per domain, with routes scoped by clinic and membership and permission checks on each one, Zod validation at the edges and a per-request service container.
- **Whitelabel by domain:** the request Host defines the brand, and from it come the identity (the same email can have one account per brand), CORS, the session cookie, the email sender and the request limits.
- **Identity and access:** email and password or Google sign in, MFA with TOTP and recovery codes, per-device sessions, permissions per profile and per person, and plan seats per type of professional.
- **Scheduling and front desk:** appointments, a waitlist, a service queue with ticket numbers and priority, and a call panel on the waiting room TV, reached through a secret link.
- **Clinical:** patients, triage, charts, exam orders and clinical documents with advanced electronic signatures or qualified ICP-Brasil signatures (Brazil's official public key infrastructure), prescriptions and templates.
- **Clinic finance:** accounts payable and receivable, cash register, cost centers, invoices and payouts to professionals in batches.
- **Clinic bank account:** incoming and outgoing Pix (Brazil's instant payment system), scheduled Pix and boleto (Brazilian bank slip) through Woovi, behind an adapter and protected by a transaction PIN.
- **Health insurance and inventory:** a consultation becomes an insurance claim, claims become batches reconciled in accounts receivable, and inventory tracks items, lots and movements.
- **Platform billing:** plans, add-on modules, one-time purchases, coupons and dunning for clinics subscribing to Salte, with Stripe, Woovi and Araute picked by a capability matrix.
- **Real time:** Durable Objects fan out events for the internal chat and the agent chat; writes always go through the REST API and Postgres is the source of truth.
- **Web front end and mobile app:** TanStack Start with React in the browser and Expo for iOS and Android, on the same API and with contracts shared through a common package.
- **Clinical AI:** an evidence engine in its own Worker, with text and vector search, numbers resolved by code and abstention when there is no basis, and an agent that operates the ERP through conversation.

## Architecture decisions

- **Clinic in the route, permission on every route.** Every business route carries the clinic in its path and goes through membership and permission checks, so isolation between clinics does not depend on someone remembering a filter in the query.
- **Brand resolved once, at the entrance.** The Host becomes the brand identifier at the start of the request, and everything that depends on it reads from there, instead of each module figuring it out on its own.
- **A single write door.** Every persistent change goes through the REST API, with authentication, permission, limits and a transaction. WebSockets and Durable Objects only fan out notifications; if fan-out fails, the client catches up through the API.
- **Providers behind adapters, chosen by data.** Bank account, billing, invoices and qualified signatures talk to providers through adapters. In billing, a capability matrix and a pure function pick the gateway, and swapping or adding a provider does not touch business rules.
- **Concurrency decided in the database.** Accumulated amounts are incremented in SQL itself, uniqueness is enforced by indexes and state transitions use an update conditioned on the state that was read, with no in-memory locks.
- **No framework where cold start matters.** Services are resolved lazily per request, with no reflection and no container at boot, and Zod schemas are only built on the first request that uses them.
- **The model writes, the code computes.** In the clinical AI, the draft carries markers that pure functions resolve, so the accuracy of a dose does not depend on the model. And abstaining is a valid answer.
