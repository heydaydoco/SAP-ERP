# Domain: Logistics / 4PL `logistics-4pl`

> **SAP mapping:** 4PL (deepened core)
> Loads automatically when working under `apps/api/src/domains/logistics-4pl/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/logistics-4pl.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `shipment-booking`
- `freight-forwarding`
- `transportation`
- `customs-brokerage`
- `3pl-warehouse`
- `control-tower`
- `cargo-tracking`
- `logistics-billing`
- `logistics-document`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

> **Note:** Heart of the system: per-shipment cost vs sell at charge granularity, planned→actual accrual, real-time margin → FI. Margin math needs Vitest unit tests (§5.4). Detail: @docs/domains/logistics-4pl.md.

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
