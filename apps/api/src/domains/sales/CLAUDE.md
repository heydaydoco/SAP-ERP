# Domain: Sales `sales`

> **SAP mapping:** SD
> Loads automatically when working under `apps/api/src/domains/sales/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/sales.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `inquiry-quotation`
- `sales-order`
- `delivery`
- `billing`
- `pricing`
- `credit-management`
- `returns`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

> **Note:** billing → FI: (Dr) AR / (Cr) revenue + output VAT. Reuse the kernel pricing engine (§4.6).

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
