# SAP-ERP

Full enterprise ERP for a ~40-person manufacturing / import-export B2B company —
SAP-module-modeled (FI/CO/MM/SD/PP/QM/HCM/TRM/GTS) with **4PL logistics deepened**.
TypeScript modular monolith.

> **Governance:** read [`CLAUDE.md`](./CLAUDE.md) first. Domain map →
> [`docs/architecture-full.md`](./docs/architecture-full.md). Roadmap →
> [`docs/phase-plan.md`](./docs/phase-plan.md).

## Stack

Turborepo + pnpm · Node 22 · TS 5.7 strict · Next.js 16 · NestJS 11 · PostgreSQL 16 + Drizzle ·
Redis 7 + BullMQ · Zod · Vitest / Testcontainers / Playwright.

## Layout

```
apps/web        Next.js 16 frontend (App Router)
apps/api        NestJS 11 modular monolith — src/domains/<domain>
apps/worker     BullMQ workers (Outbox relay, batch, async handlers)
packages/kernel       cross-cutting spine: document framework, event bus, fi-posting,
                      account determination, pricing engine
packages/db           Drizzle schema + migrations
packages/shared       Zod DTOs + shared enums
packages/ui           shadcn/ui components
packages/config       shared eslint / tsconfig / prettier
packages/trade-data   HS / FTA / SPL reference data
```

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm infra:up         # PostgreSQL 16 + Redis 7 via docker compose

pnpm dev              # all apps (turbo builds workspace packages first)
pnpm test:unit        # Vitest unit tests (no build needed)
pnpm test:integration # Testcontainers (needs Docker; no build needed)
pnpm test:e2e         # Playwright (boots web)
pnpm typecheck && pnpm lint
```

### Run the API/worker against the DB

Workspace packages compile to **CommonJS `dist`**, so build once before running `node dist`
(seed, start). Tests don't need this (Vitest aliases packages to source).

```bash
pnpm build                          # all packages + apps → dist
pnpm --filter @erp/db db:migrate    # apply migrations
pnpm --filter @erp/api seed         # admin user + ADMIN role + demo number ranges (idempotent)
pnpm --filter @erp/api start        # node dist/main.js
```

## Status

🟧 **Phase 0 in progress** (platform). Foundation + kernel, doc-flow/outbox/event bus, numbering,
auth (JWT), rbac (CASL) are in. See `docs/phase-plan.md`.
