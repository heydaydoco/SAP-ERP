# Domain: Platform / Foundation `platform`

> **SAP mapping:** Basis + IMG
> Loads automatically when working under `apps/api/src/domains/platform/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/platform.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `auth`
- `rbac`
- `org-structure`
- `numbering`
- `workflow`
- `notification`
- `file-storage`
- `audit-log`
- `i18n`
- `admin-config`
- `data-migration`
- `output-forms`
- `job-monitor`

## Status
🟦 **Scaffold only.** No tables, services, or controllers yet — see `@docs/phase-plan.md` for when
this domain is built and fill the sections below at that time.

> **Note:** Phase 0 domain. Builds the kernel-backed plumbing (RBAC `domain:subject:action`, Number Range, fiscal-period control in admin-config) every other domain depends on.

## Domain rules
_(domain-specific rules, invariants, and terminology — TBD)_

## Key tables
_(core entities; extend the kernel document framework, add the audit-4 columns — TBD)_

## FI postings
_(which events post to the GL and the debit/credit pattern via fi-posting — TBD)_

## Domain events
_(events published / subscribed on the bus — TBD)_
