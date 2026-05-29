# Domain: Contract & SLA `contract`

> **SAP mapping:** CLM
> Loads automatically when working under `apps/api/src/domains/contract/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/contract.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `sales-contract`
- `purchase-contract`
- `service-contract`
- `sla-monitoring`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

> **Note:** service-contract drives 4PL rates/renewal; sla-monitoring raises KPI/SLA-breach alerts via the event bus.

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
