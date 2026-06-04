# Domain: Master Data `master-data`

> **SAP mapping:** Cross-application master data (FI/CO/MM/SD master records)
> Loads automatically when working under `apps/api/src/domains/master-data/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec: `@docs/domains/master-data.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `currency` (+ `fx-rate`) ✅ — currency master + foreign-exchange rates
- `gl-account` ✅ — chart of accounts (계정과목)
- `tax-code` ✅ — VAT codes (부가세)
- `cost-center` ✅ — CO cost object (코스트센터)
- `material` · `business-partner` — next PR (Phase 1, slice 2)
- `bom` · `profit-center` · `bank-master` · `uom` · `pricing-condition` — later

## Status
🟧 **In progress (Phase 1, slice 1 of 2).** Shipped: the FI-foundation masters
(currency/fx-rate · gl-account · tax-code · cost-center) that finance-accounting (Phase 2) sits on.
Remaining for Phase 1: `material` (+ trade extension), `business-partner` (+ customer/vendor roles).

> **Note:** Use the master extension/role pattern (§4.4): core master + per-domain extension tables
> (material→sales/purchasing/mrp/trade; BP→customer/vendor/carrier). Applies to the next slice.

## Domain rules
- **Currency master is the source of minor-unit exponents (§3.1).** `DbCurrencyRegistry` implements
  the kernel `CurrencyRegistry`; `Money` is built with it so decimals are never hard-coded as
  "2 cents". Every currency-master write calls `registry.reload()`.
- **Masters use a surrogate `uuid id`; the business code is a unique natural key** — unique within
  the parent where scoped: `gl_account` per chart of accounts, `cost_center` per company code,
  `fx_rate` per (from, to, rate_type, valid_from).
- **`create*` throws on duplicate (API); idempotent `ensure*` returns the id (seed)** — same split as
  org-structure, keeping the seed re-runnable.
- **GL normal balance** comes from `normalBalance()` in `@erp/shared` (asset/expense = D; rest = C);
  fi-posting (Phase 2) uses it to validate journal-line debit/credit indicators.
- **Tax + FX are unit-tested calc paths (§5.4).** Tax rounds through `Money.percentage`; FX
  resolution is the pure `resolveFxRate(candidates, onDate)` helper (latest valid_from ≤ date).

## Key tables
- `currency` (code, minor_unit, symbol) · `fx_rate` (from/to/rate_type/valid_from → rate numeric(18,6))
- `gl_account` (chart_of_accounts + account_number unique; account_type enum; is_reconciliation)
- `tax_code` (code, kind OUTPUT/INPUT, rate_percent, gl_account)
- `cost_center` (company_code_id + code unique; valid_from/valid_to; responsible)

## FI postings
_(none — master data is referenced by FI postings; it does not itself post to the GL)_

## Domain events
_(none yet)_

## Permissions
`master_data:<subject>:<action>` — subjects `currency`, `fx_rate`, `gl_account`, `tax_code`,
`cost_center`; actions `read`, `create`. (The ADMIN role's `*` grant covers them.)
