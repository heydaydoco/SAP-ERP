# Domain: Finance & Accounting `finance-accounting`

> **SAP mapping:** FI
> Loads automatically when working under `apps/api/src/domains/finance-accounting/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/finance-accounting.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `general-ledger`
- `accounts-receivable`
- `accounts-payable`
- `fixed-assets`
- `tax`
- `bank-reconciliation`
- `period-close`
- `financial-statements`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

> **Note:** The backbone. Owns journal_entry/journal_line. Enforce immutability + reversal-only + period locking (§5.1). Hosts the concrete fi-posting service from the kernel.

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
