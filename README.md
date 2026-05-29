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

pnpm dev              # all apps
pnpm test:unit        # Vitest unit tests
pnpm test:integration # Testcontainers (needs Docker)
pnpm test:e2e         # Playwright (boots web)
pnpm typecheck && pnpm lint
```

## Status

🟦 **Foundation scaffold only.** No domain/app code yet — Phase 0 (platform) starts next.
See `docs/phase-plan.md`.
