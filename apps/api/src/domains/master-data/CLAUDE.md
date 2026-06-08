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
- `business-partner` ✅ — SAP BP core + customer/vendor roles (거래처)
- `material` ✅ — material core + trade extension (품목 + HS코드/무역속성)
- `bom` · `profit-center` · `bank-master` · `uom` · `pricing-condition` — later

## Status
🟩 **Phase 1 complete.** Shipped: FI-foundation masters (currency/fx-rate · gl-account · tax-code ·
cost-center), `business-partner` (core + customer/vendor roles), and `material` (core + trade
extension). Next is **Phase 2 finance-accounting (FI)**. Deferred to later slices/domains: material
sales/purchasing/mrp extensions, BP carrier/bank roles, uom · bom · profit-center · pricing-condition.

> **Note:** Master extension/role pattern (§4.4): core master + per-domain extension tables.
> business-partner (core BP → `customer`/`vendor`) and material (core → `material_trade`) both apply
> it; further material views (sales/purchasing/mrp) attach the same way when those domains arrive.

## Domain rules
- **Currency master is the source of minor-unit exponents (§3.1).** `DbCurrencyRegistry` implements
  the kernel `CurrencyRegistry`; `Money` is built with it so decimals are never hard-coded as
  "2 cents". Every currency-master write calls `registry.reload()`.
- **Masters use a surrogate `uuid id`; the business code is a unique natural key** — unique within
  the parent where scoped: `gl_account` per chart of accounts, `cost_center` per company code,
  `fx_rate` per (from, to, rate_type, valid_from).
- **`create*` throws on duplicate (API); idempotent `ensure*` returns the id (seed)** — same split as
  org-structure, keeping the seed re-runnable.
- **GL normal balance** comes from `normalBalance()` in `@erp/shared` (asset/expense = D; rest = C).
  It is a presentation/reporting concept (trial-balance signs) — NOT a posting gate; fi-posting
  accepts both sides on any account (crediting an asset is how it decreases).
- **Tax + FX are unit-tested calc paths (§5.4).** Tax rounds through `Money.percentage`; FX
  resolution is the pure `resolveFxRate(candidates, onDate)` helper (latest valid_from ≤ date).
- **BP roles are 1:1 extension tables, not a type.** A partner gets a `customer` and/or `vendor` row
  (one each, `bp_id` unique). A role's reconciliation account must exist in `gl_account` **and be
  flagged `is_reconciliation = true`** before it can be attached (a non-recon account would post AR/AP
  lines that never surface in the subledger). Bank details stay out of `vendor` (bank-master later) to
  avoid duplicating PIPA data (§5.3).

## Key tables
- `currency` (code, minor_unit, symbol) · `fx_rate` (from/to/rate_type/valid_from → rate numeric(18,6))
- `gl_account` (chart_of_accounts + account_number unique; account_type enum; is_reconciliation)
- `tax_code` (code, kind OUTPUT/INPUT, rate_percent, gl_account)
- `cost_center` (company_code_id + code unique; valid_from/valid_to; responsible)
- `business_partner` (code unique; bp_type ORGANIZATION/PERSON) · `customer` (bp_id unique;
  ar_recon_account; credit_limit) · `vendor` (bp_id unique; ap_recon_account)
- `material` (code unique; material_type enum; base_uom; material_group) · `material_trade`
  (material_id unique; hs_code; country_of_origin)

## FI postings
_(none — master data is referenced by FI postings; it does not itself post to the GL)_

## Domain events
_(none yet)_

## Permissions
`master_data:<subject>:<action>` — subjects `currency`, `fx_rate`, `gl_account`, `tax_code`,
`cost_center`, `business_partner`, `material`; actions `read`, `create`, plus `manage_role` on
`business_partner` and `manage_extension` on `material` (attach roles / trade extension).
(The ADMIN role's `*` grant covers them.)
