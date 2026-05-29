# Domain: Master Data `master-data`

> **SAP mapping:** Master Data
> Loads automatically when working under `apps/api/src/domains/master-data/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/master-data.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `material`
- `business-partner`
- `bom`
- `gl-account`
- `cost-center`
- `profit-center`
- `bank-master`
- `currency`
- `fx-rate`
- `uom`
- `tax-code`
- `pricing-condition`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

> **Note:** Use the master extension/role pattern (§4.4): core master + per-domain extension tables (material→sales/purchasing/mrp/trade; BP→customer/vendor/carrier).

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
