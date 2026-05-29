# Domain: HR & Payroll (Korea) `hr-payroll`

> **SAP mapping:** HCM
> Loads automatically when working under `apps/api/src/domains/hr-payroll/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/hr-payroll.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `org-management`
- `personnel`
- `time`
- `payroll`
- `year-end-tax`
- `severance`
- `recruiting`
- `appraisal`
- `expense`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

> **Note:** PIPA-critical (§5.3): rrn/bank_acct/payroll encrypted at rest + access audit + masking. 4-insurance rates are NEVER hard-coded — read from insurance_rate by effective_from. Payroll calc needs Vitest unit tests (§5.4). Detail: @docs/domains/hr-payroll.md.

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
