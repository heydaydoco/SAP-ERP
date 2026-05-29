# Domain: CRM `crm`

> **SAP mapping:** Sales Cloud / C4C
> Loads automatically when working under `apps/api/src/domains/crm/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/crm.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `account-contact`
- `lead`
- `opportunity`
- `activity`
- `campaign`
- `crm-quotation`
- `service-ticket`
- `forecast`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

> **Note:** opportunity WON → sales.sales_order via doc_flow (§4.3).

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
