# Phase Plan — Balanced Development Roadmap (Phase 0–12)

> Source of truth for sequencing. Derived from `@docs/architecture-full.md` §4.
> Governance rules live in the root `CLAUDE.md`.

## Guiding principle — vertical slices, not horizontal layers

A full ERP across 17 domains is ~10–12 months for 1–2 people + Claude Code. The strategy is
**per-domain vertical slice**: do **not** try to finish a domain end-to-end in one go. Instead,
push a thin slice through every layer first, then deepen the high-value domains (trade / 4PL).

For each domain, a vertical slice = thin cut through the whole stack:

```
master data  →  one core transaction  →  FI posting link  →  basic screen + report
```

Only after the slice runs do we widen it. **One domain = one PR.** This keeps all 17 domains on the
same kernel spine (document framework · event bus · fi-posting · account determination · pricing)
and avoids spaghetti.

## Phase 0 prerequisite — the kernel spine

Before any business domain, `packages/kernel` must implement the cross-cutting patterns
(document framework, event bus, fi-posting, account determination, pricing engine). The 14+
downstream domains all sit on this spine — building it first is what prevents rework.

## Roadmap

| Phase | Domain(s) | Core deliverable | Est. |
|------:|-----------|------------------|------|
| **0** | platform | auth · rbac (CASL) · org-structure · numbering · workflow · notification · admin-config · data-migration · output-forms + **kernel cross-cutting patterns** | 2–3 wk |
| **1** | master-data | material · business-partner · gl-account · currency/fx-rate · cost-center · tax-code | 3 wk |
| **2** | finance-accounting | double-entry GL · AR · AP (the backbone of every domain) | 3–4 wk |
| **3** | procurement + inventory + **landed-cost** | PR→PO→GR→IV + inventory (moving average) + import landed-cost allocation → FI | 4–5 wk |
| **4** | sales + **contract** | inquiry→quote→order→delivery→billing + contract/SLA → FI | 4 wk |
| **5** | crm + **portal (client visibility)** | account·lead·opportunity·activity → SD link + 4PL cargo-tracking portal | 3–4 wk |
| **6** | manufacturing-quality + **planning** | demand-forecast→S&OP→MRP→production order · quality inspection | 5 wk |
| **7** | trade-compliance + **integration** | L/C · customs · FTA · HS · docs + connectors (UNI-PASS · HomeTax · SWIFT · KTNET) | 5 wk |
| **8** | logistics-4pl (deepest) | forwarding · TM · tracking · logistics billing (cost vs sell, accrual, per-shipment margin) | 6 wk |
| **9** | hr-payroll + **portal (ESS/MSS)** | org · personnel · time · payroll (4 insurances) · severance + employee self-service | 5–6 wk |
| **10** | treasury | cash management · FX risk · firm-banking · payment run | 3 wk |
| **11** | controlling + analytics | CO-PA · product costing · domain dashboards | 3 wk |
| **12** | integration · close · deploy | month-end close · permission hardening · production deploy | 3 wk |

## MVP boundary

**Phase 0–4** (foundation + master + accounting + procurement/inventory + sales) is the
**minimum working ERP** — once it runs, the company's core operations already function.
Phases 5–12 attach in value order. For a heavy trade/import-export business, Phases 7 & 8 may be
pulled forward right after Phase 4.

## Phase 0 scope detail (platform)

Modules: `auth` · `rbac` · `org-structure` · `numbering` · `workflow` · `notification` ·
`file-storage` · `audit-log` · `i18n` · `admin-config` · `data-migration` · `output-forms` ·
`job-monitor`.

Kernel patterns (in `packages/kernel`, consumed by all later domains):
document framework (header+item base) · `doc_flow` · event bus (in-proc + Outbox→BullMQ) ·
fi-posting service + idempotency · account-determination config · pricing/condition engine ·
base controller (paging/filter/error format).

## Execution caveat (doc §5)

Web Claude Code is great for code + PRs, but **do not stack 17 domains of unrun code**. Plan:
generate Phase 0–2 (foundation + master + accounting) on web, then stand up a **real run
environment** (local Docker Postgres via `--teleport`, or a cheap cloud dev env) and validate by
actually running, migrating, and clicking before continuing. Nine months of unrun code is the
biggest trap.
