# Domain: Trade & Compliance `trade-compliance`

> **SAP mapping:** GTS
> Loads automatically when working under `apps/api/src/domains/trade-compliance/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/trade-compliance.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `letter-of-credit`
- `customs-declaration`
- `fta-origin`
- `hs-classification`
- `duty-drawback`
- `trade-document`
- `incoterms`
- `compliance-screening`
- `cargo-insurance`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

> **Note:** duty-drawback is a real cash item for import-manufacture-export — unit-test the refund calc. Reference data from @erp/trade-data.

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
