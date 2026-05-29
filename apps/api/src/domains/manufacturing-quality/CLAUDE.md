# Domain: Manufacturing & Quality `manufacturing-quality`

> **SAP mapping:** PP + QM
> Loads automatically when working under `apps/api/src/domains/manufacturing-quality/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/manufacturing-quality.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `bom-management`
- `routing`
- `mrp`
- `production-order`
- `capacity-planning`
- `confirmation`
- `subcontracting`
- `quality`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
