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
🟧 **In progress (Phase 0).** Shipped: `doc-flow`, `outbox`, event bus (PR #2); `numbering`,
`auth`, `rbac` (this PR). Remaining: `org-structure`, `admin-config` (+ fiscal-period/account
determination), `workflow`, `notification`, `file-storage`, `audit-log`, `i18n`, `data-migration`,
`output-forms`, `job-monitor`.

> **Note:** Phase 0 domain. Builds the kernel-backed plumbing (RBAC `domain:subject:action`, Number
> Range, fiscal-period control in admin-config) every other domain depends on.

## Domain rules
- **Permissions** are `domain:subject:action` strings; `*` = superuser. Enforced globally by
  `JwtAuthGuard` → `PermissionsGuard`. Routes are authenticated by default — opt out with `@Public()`,
  opt into authorization with `@RequirePermissions(...)`. Grants are re-read from the DB on each
  login/refresh and embedded in the access token.
- **Numbering** is gap-free: `NumberingService.next(object, scope)` does an atomic increment +
  RETURNING (row lock serializes callers). One counter per `(object, scope)`; `scope` partitions by
  year/org. Every document `doc_no` comes from here — never ad-hoc.
- **Passwords** are bcrypt-hashed; plaintext is never stored or logged (§5.3).

## Key tables
- `app_user` (login account; password hash only) · `role` · `role_permission`
  (`domain:subject:action`) · `user_role` · `number_range` (counter per object/scope).
- From PR #2: `doc_flow`, `outbox`.

## FI postings
_(none — platform is infrastructure)_

## Domain events
_(none yet; the in-process bus + Outbox relay are provided here for other domains to use)_
