# Domain Spec — master-data

> Domain detail for `master-data`. Governance: root `CLAUDE.md`. Sequencing: `@docs/phase-plan.md`.
> Domain map / SAP mapping: `@docs/architecture-full.md` §② master-data.

## Purpose

The cross-application master records every other domain references. Phase 1 delivers it in **two
slices** so each PR stays reviewable:

1. **Slice 1 (this PR) — FI-foundation masters:** currency/fx-rate, gl-account, tax-code,
   cost-center. These are what finance-accounting (Phase 2) and account-determination depend on.
2. **Slice 2 (next PR):** material (+ trade extension) and business-partner (+ customer/vendor roles),
   following the master extension/role pattern (§4.4).

Later (per architecture §②): bom, profit-center, bank-master, uom, pricing-condition.

## Slice 1 — masters shipped

### currency + fx_rate
- `currency`: ISO-4217 `code` (natural key) · `name` · **`minor_unit`** (decimal places, 0–4) · `symbol`.
  The authoritative minor-unit source (§3.1). `DbCurrencyRegistry` loads it into the kernel
  `CurrencyRegistry` so `Money` uses exact per-currency decimals — never a hard-coded 2.
- `fx_rate`: (`from_currency`, `to_currency`, `rate_type` ['M' = monthly average], `valid_from`) →
  `rate` `NUMERIC(18,6)`. Resolution picks the latest `valid_from ≤ posting date` via the pure
  `resolveFxRate()` helper (unit-tested, §5.4). Exposed at `GET /master-data/fx-rates/resolve`.

### gl-account (계정과목)
- `gl_account`: `account_number` unique **within `chart_of_accounts`** · `name` · `account_type`
  (ASSET/LIABILITY/EQUITY/REVENUE/EXPENSE) · optional account `currency` · `is_reconciliation`
  (AR/AP control accounts posted only via their subledger).
- `normalBalance(account_type)` (in `@erp/shared`) gives the debit/credit side; fi-posting (Phase 2)
  validates journal lines against it.

### tax-code (부가세)
- `tax_code`: `code` (unique) · `kind` (OUTPUT 매출 / INPUT 매입) · `rate_percent` · optional VAT
  `gl_account`. Tax amount = `Money.percentage(rate_percent)` — currency-aware rounding, one path for
  tax + pricing (§5.4). `GET /master-data/tax-codes/:code/quote?baseAmount=&currency=` demonstrates it.

### cost-center (코스트센터)
- `cost_center`: `code` unique **within `company_code`** · `name` · time-dependent `valid_from`/
  `valid_to` · `responsible`. The CO object FI expense lines carry.

## Conventions
- Surrogate `uuid id`; `snake_case` DB identifiers; audit-4 columns on every table (§3.3, §3.4).
- `create*` (409 on duplicate) for the API; idempotent `ensure*` for the seed.
- Permissions `master_data:<subject>:<action>` (subjects: currency, fx_rate, gl_account, tax_code,
  cost_center). Secure-by-default via the global JwtAuthGuard + PermissionsGuard.

## Seed (demo)
Currencies KRW(0)/USD(2)/EUR(2)/CNY(2)/JPY(0); fx USD→KRW, EUR→KRW (from 2026-01-01); KR01 GL accounts
backing the existing determination rules (1100 AR / 4000 revenue / 2550 output-VAT) + 1000 cash /
2100 AP; tax codes V10 (OUTPUT 10%) / A10 (INPUT 10%); cost center 1000 under company 1000.

## Tests
`Money.percentage` (kernel), `normalBalance` (shared), `resolveFxRate` + `computeTax` (api) — all
pure unit tests, no DB. FI posting integration tests arrive with Phase 2.
