---
title: Yield
role: Creator, paused personal project
period: May 2026, paused
summary: "If you have accounts at several banks, you can't see where your money goes. I built alone the first version of an app that brings the accounts together through Open Finance, classifies spending and detects subscriptions."
order: 4
stack: [TypeScript, Hono, Kysely, Zod, PostgreSQL, Cloudflare Workers, TanStack Start, React, Tailwind CSS, Pluggy]
---

## Context

Yield brings all of a person's accounts into one place, pulling data straight from the banks through Open Finance (the Central Bank's regulated standard for sharing banking data with the customer's consent), via Pluggy. On top of that, it classifies spending, detects recurring charges and shows net worth. I built the first version of the app and the API. The most interesting problems I solved are in the posts below.

## My role

Fullstack developer, alone on both ends. I designed the data model, the API, the sync and classification pipeline, recurrence detection, authentication with 2FA and the front end.

## Architecture at a glance

- **API (Hono, Kysely, PostgreSQL via Hyperdrive, Cloudflare Workers):** one module per business entity, each with a controller, service, repository and Zod schema, assembled on every request with no dependency injection framework.
- **Pluggy webhook:** a public endpoint authenticated by a secret header, which records the event, answers 2XX right away and triggers the sync in the background.
- **Classification queue (Cloudflare Queues):** processes classification requests, categorizes transactions by merchant aliases and rules, writes the result to a separate layer and reconciles recurrences at the end.
- **Recurrences:** a pure detector with no side effects, and a materialized series table, updated on every classification.
- **Authentication:** sessions with a rotating refresh token grouped by family, TOTP 2FA (the six-digit code from an authenticator app) and recovery codes.
- **App (TanStack Start, React, Tailwind):** consumes the API and translates into Portuguese the error codes, which come prefixed by the originating module.

## Architecture decisions

- **Kysely with no ORM**, with repositories per module and filters resolved in SQL, including a denormalized search column on the transaction so the listing doesn't depend on joins.
- **Idempotency in the database.** A partial unique index on Pluggy's external id in each mirrored table guarantees the same data never enters twice, with no need for one giant end-to-end transaction.
- **Classification separate from banking data.** Category and user edits live in their own layer, so resyncing with the bank never erases what the person adjusted.
- **Materialized recurrences**, not just computed on read, to remember canceled series and user decisions.
- **A cache that respects the transaction:** cache writes only count after the commit, so a state that was rolled back is never exposed.
- **Reconciliation through the queue**, so opening the dashboard never triggers a write.
