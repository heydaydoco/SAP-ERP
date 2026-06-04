# Domain Spec — master-data

> Domain detail for `master-data`. Governance: root `CLAUDE.md`. Sequencing: `@docs/phase-plan.md`.
> Domain map / SAP mapping: `@docs/architecture-full.md` §② master-data.

## Purpose

The cross-application master records every other domain references. Phase 1 delivered it in
**reviewable slices** (one PR each), now **complete**:

1. **Slice 1 — FI-foundation masters:** currency/fx-rate, gl-account, tax-code, cost-center.
   What finance-accounting (Phase 2) and account-determination depend on.
2. **Slice 2 — business-partner:** core BP + customer/vendor roles (§4.4). Sequenced before material
   because Phase 2 AR/AP depend on the BP roles.
3. **Slice 3 — material:** core material + trade extension (§4.4).

Next: **Phase 2 finance-accounting (FI)**. Later (per architecture §②): bom, profit-center,
bank-master, uom, pricing-condition; material sales/purchasing/mrp views and BP carrier/bank roles.

## Masters shipped (slices 1–3)

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

### business-partner (거래처 = SAP BP)
- `business_partner` (core): `code` (partner number, natural key) · `name` · `bp_type`
  (ORGANIZATION/PERSON) · `tax_id` · address fields. One record, many **roles** (§4.4).
- `customer` role (AR): 1:1 (`bp_id` unique) · `ar_recon_account` (외상매출금, must exist in
  `gl_account`) · optional `credit_limit` + `credit_currency` · `payment_terms_days` · `sales_block`.
- `vendor` role (AP): 1:1 · `ap_recon_account` (외상매입금) · `payment_terms_days` · `purchasing_block`.
  Bank details deferred to bank-master (PIPA §5.3 — not duplicated here).
- Flow: `POST /master-data/business-partners` (core) → `POST .../:id/customer-role` |
  `.../:id/vendor-role`. `GET .../:id` returns the partner with its roles.
- carrier/bank roles arrive with logistics-4pl / bank-master later.

### material (품목)
- `material` (core): `code` (material number, natural key) · `name` · `material_type`
  (FINISHED/SEMI_FINISHED/RAW/TRADING/SERVICE) · `base_uom` (unit code; uom master is later) ·
  `material_group` · optional `net_weight` + `weight_unit`.
- `material_trade` role (1:1, `material_id` unique): `hs_code` (관세 품목분류) · `country_of_origin` ·
  `export_control_class`. Feeds trade-compliance (HS classification, FTA origin) later.
- Flow: `POST /master-data/materials` (core) → `POST .../:id/trade-data`. `GET .../:id` returns the
  material with its trade extension. sales/purchasing/mrp views attach the same way later.

## Conventions
- Surrogate `uuid id`; `snake_case` DB identifiers; audit-4 columns on every table (§3.3, §3.4).
- `create*` (409 on duplicate) for the API; idempotent `ensure*` for the seed.
- Permissions `master_data:<subject>:<action>` (subjects: currency, fx_rate, gl_account, tax_code,
  cost_center, business_partner, material; `manage_role` attaches BP roles, `manage_extension`
  attaches the material trade view). Secure-by-default via the global JwtAuthGuard + PermissionsGuard.

## Seed (demo)
Currencies KRW(0)/USD(2)/EUR(2)/CNY(2)/JPY(0); fx USD→KRW, EUR→KRW (from 2026-01-01); KR01 GL accounts
backing the existing determination rules (1100 AR / 4000 revenue / 2550 output-VAT) + 1000 cash /
2100 AP; tax codes V10 (OUTPUT 10%) / A10 (INPUT 10%); cost center 1000 under company 1000; business
partners customer C1000 (AR 1100, credit 50M KRW) + vendor V2000 (AP 2100); materials FG-1000
(FINISHED, HS 8471606000, origin KR) + RM-2000 (RAW).

## Tests
`Money.percentage` (kernel), `normalBalance` (shared), `resolveFxRate` + `computeTax` (api) — all
pure unit tests, no DB. business-partner is CRUD (no calc); AR/AP + FI posting integration tests
arrive with Phase 2.
