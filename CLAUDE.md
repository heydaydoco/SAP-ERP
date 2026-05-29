# SAP-ERP — Project Constitution (root CLAUDE.md)

> Authoritative governance for the whole repo. Domain detail lives in
> per-domain `CLAUDE.md` files; the full domain map is `@docs/architecture-full.md`.
> Keep this file ≤200 lines. If a rule conflicts with code, **the rule wins** — fix the code.

## 1. What we are building

A **full enterprise ERP** for a ~40-person manufacturing / import-export B2B company:
SAP-module-modeled (FI/CO/MM/SD/PP/QM/HCM/TRM/GTS …) with **4PL logistics deepened**.
17 domains + cross-cutting. Built by 1–2 people + Claude Code over ~10–12 months.
Strategy = **per-domain vertical slice**: master → one core transaction → FI link → screen/report.
See `@docs/phase-plan.md` for the Phase 0–12 roadmap.

## 2. Tech stack (fixed)

- **Monorepo**: Turborepo + pnpm workspaces (Node 22, TS 5.7 strict).
- **web**: Next.js 16 (App Router). **api**: NestJS 11 (modular monolith). **worker**: BullMQ.
- **DB**: PostgreSQL 16 + Drizzle ORM/migrations. **Cache/Queue**: Redis 7 + BullMQ.
- **Validation**: Zod (shared DTOs). **Auth**: JWT + CASL RBAC.
- **Type safety**: REST + OpenAPI → generated TS client (no FE/BE type drift).
- **Tests**: Vitest (unit) · Testcontainers (integration) · Playwright (e2e).
- **Obs**: Pino logs · Sentry · Prometheus/Grafana.

### Workspace layout
```
apps/web      Next.js 16 frontend
apps/api      NestJS 11 — src/domains/<domain>/<module>
apps/worker   BullMQ workers (batch / async event handlers)
packages/kernel       cross-cutting patterns (doc framework, event bus, fi-posting,
                      account determination, pricing engine) — the spine
packages/db           Drizzle schema + migrations + drizzle.config.ts
packages/shared       Zod DTOs + shared enums (Incoterms, MT types, …)
packages/ui           shared React components (shadcn/ui)
packages/config       shared eslint / tsconfig / prettier
packages/trade-data    HS CSV · FTA agreements · SPL lists
```

## 3. Global rules (non-negotiable, every domain)

1. **Money = `NUMERIC(18,2)`**. Never `float`/`double` for amounts. Quantities/rates may use
   higher scale (e.g. `NUMERIC(18,6)`) but money is always (18,2). Currency is a separate column.
2. **Every transaction flows through `fi-posting`.** A module that moves value MUST emit a
   balanced double-entry journal via the kernel fi-posting service. Never write GL accounts ad-hoc.
3. **`snake_case`** for all DB identifiers (tables, columns, enums, constraints).
   TS code is `camelCase`; the Drizzle layer maps between them.
4. **Audit 4 columns on every table**: `created_at`, `created_by`, `updated_at`, `updated_by`.
   Set via a shared base — never per-table reinvention.
5. **No soft-delete.** No `is_deleted` / `deleted_at`. Use status fields + immutability +
   reversal (see §5.1). History is preserved via `doc_flow` and reversal entries, not tombstones.
6. **Permissions are `domain:subject:action`** (e.g. `sales:sales_order:approve`). Defined once,
   enforced by CASL. No string-literal permission checks scattered in code.
7. **Audit & access logging** for sensitive reads (see §5.3). **Secrets via env/secret manager**,
   never in code or git. Validate every input at the edge with Zod.

## 4. Structure design principles (doc §3-B) — avoid 17-domain spaghetti

These outrank feature work. The kernel exists to enforce them once.

1. **Modular monolith — microservices forbidden.** One backend (`apps/api`), domains separated
   only by `domains/` module boundaries. No network boundary between domains.
2. **Common document framework.** Every transaction document shares one base:
   `[header + item + status + numbering + audit-4 + attachments + partner-ref + FI-posting hook]`.
   Defined once in `packages/kernel`; domains extend, never re-implement.
3. **Document Flow table.** Generic `doc_flow(source_type, source_id, target_type, target_id,
   rel_type)` traces the whole chain (quote→order→delivery→billing→FI, opportunity→order …).
   No proliferation of bespoke FK links for traceability.
4. **Master extension / role pattern.** Core master + per-domain extension tables
   (material → material_sales/purchasing/mrp/trade; BP → customer/vendor/carrier roles).
   Neither one giant table nor copies.
5. **Account determination + fi-posting engine.** (transaction type · material group … → GL
   account) mapping lives in an `account_determination` config table, editable by accounting
   without code changes. **No hard-coded posting accounts.**
6. **Common pricing/condition engine.** SD price, PO price, carrier freight, logistics charges all
   reuse one pricing(condition) engine. No per-domain price logic duplication.
7. **Domain event bus.** Emit domain events (`BillingPosted`, …); AR/FI/Treasury/analytics
   subscribe. In-process EventEmitter for sync; BullMQ for async. Minimize direct cross-domain calls.
8. **Module scaffold generator (Skill `erp-module-scaffold`).** Generates
   entity→migration→repo→service→controller→DTO→test→CRUD-screen identically across domains.
9. **Reporting = read model / MV.** Dashboards read event-updated read models / materialized views
   / Metabase replica. Never hit OLTP with 17-domain live joins.

Plus: common base controller (paging/filter/error format unified) · fiscal period/year control
lives in `admin-config`.

## 5. Non-functional rules (doc §3-C) — the body of an ERP

### 🔴 Mandatory (financial integrity / legal — non-negotiable)
5.1 **Journal immutability + reversal.** A `posted` journal_entry is never edited or deleted —
    correct only by a reversal entry. **Period locking** blocks posting into closed periods.
5.2 **Posting idempotency + Outbox.** Event chains (BillingPosted→AR→FI→Treasury) must never
    double-post. Use an `outbox` table for exactly-once delivery; every FI posting carries an
    **idempotency key**.
5.3 **PIPA / personal-data protection.** Encrypt at rest: **resident reg. no (rrn), bank account,
    payroll**. Add **access audit** on reads + **screen masking**. Violations carry fines.
    Secrets via env/secret manager. AuthN/AuthZ + Zod validation on every layer.
5.4 **Calculation logic unit tests are mandatory.** Payroll (4 insurances/allowances),
    landed-cost allocation, 4PL per-shipment margin, FX translation, duty drawback — wrong math =
    wrong money. Enforce **Vitest unit tests** (incl. edge cases). FI postings get Testcontainers
    integration tests.

### 🟡 Operational (build alongside)
- Time-partition + index + archive high-volume tables (`journal_line`, `tracking_event`,
  `bank_transaction`, `logistics_charge`).
- Observability + backups + DR (defined RPO/RTO).
- Env separation dev/staging/prod (never test on prod DB) + per-domain seed/demo data.

## 6. How to work here

- **One domain = one PR.** New session → one domain vertical slice → merge → next.
  Never "build the whole ERP" in one shot.
- A domain's own `CLAUDE.md` (`apps/api/src/domains/<domain>/CLAUDE.md`) auto-loads when working
  there; put domain-only rules/terms/tables there, not here.
- Detailed specs split under `docs/domains/<domain>.md`. One file per domain, never one mega-file.
- **Skills**: `fi-posting-validator` (dr=cr) · `drizzle-migration` · `korean-payroll-calc` ·
  `mt700-parser` · `logistics-margin-calc` · `unipass-api-client`.
- **Subagents**: `db-architect` · `security-reviewer` (rrn encryption) · `test-runner` ·
  `domain-checker`.

## 7. Domain map index

17 domains + cross-cutting (landed-cost, fi-posting) + analytics. Full map, SAP mapping, data
models, FI integration rules → **`@docs/architecture-full.md`**. Roadmap → **`@docs/phase-plan.md`**.

platform · master-data · finance-accounting · controlling · treasury · procurement ·
inventory-warehouse · sales · crm · manufacturing-quality · logistics-4pl · trade-compliance ·
hr-payroll · integration · planning · portal · contract.
