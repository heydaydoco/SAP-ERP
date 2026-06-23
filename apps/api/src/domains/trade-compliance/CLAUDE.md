# Domain: Trade & Compliance `trade-compliance`

> **SAP mapping:** GTS
> Loads automatically when working under `apps/api/src/domains/trade-compliance/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/trade-compliance.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `customs-declaration` 🟧 — **`export-declaration` (수출신고) shipped** (Phase 7 slice 1). Import 수입신고 later.
- `letter-of-credit` · `fta-origin` · `hs-classification` · `duty-drawback` · `trade-document` ·
  `incoterms` · `compliance-screening` · `cargo-insurance` — later.

## Status
🟧 **In progress (Phase 7 slice 1: export-declaration 수출신고, migration 0016).** First real code in the
domain. A 수출신고 is a **non-posting** customs document — a Korean export is 영세율 (no output VAT, no
export duty), so value already moved at SD billing; the declaration **posts NOTHING to FI**. Its only
linkage is a doc_flow `DECLARES` edge onto the exported delivery's **601 GI** (`inventory.goods_movement`).
Lifecycle: **create (SUBMITTED) → accept (수리 → ACCEPTED)**, the latter stamping the externally-issued
수출신고번호/MRN (captured as a manual string — the UNI-PASS connector is **deferred** to the integration
domain). **Deferred:** UNI-PASS 전자통관 connector (integration/unipass-connector), 통관수수료/관세환급
(duty-drawback) postings, FTA origin / HS-classification against `@erp/trade-data`, compliance-screening
(SPL), L/C (MT700), and web screens (matches recent slices #16–#20 — backend + tests only).

> **Note:** the externally-issued 수출신고번호 (UNI-PASS MRN) is a SEPARATE column (`declaration_no`) from
> the internal `doc_no` (ED-NNNNNN minted by NumberingService). You mint the latter; 관세청 issues the former.

## Domain rules
- **An export declaration posts NOTHING to FI.** Creating an `export_declaration` IS the explicit 수출
  declaration (never inferred from `trade_direction`). Value moved at SD billing (Dr AR / Cr revenue, the
  line tax_code **V00** zero-rating drops the VAT line). The declaration may be FOREIGN-currency; the
  currency only has to exist in the master, and a foreign declaration stamps `exchange_rate` (document-date
  'M' rate) as an audit/report value only — there is no journal.
- **Physical lineage = the delivery, NOT the billing (§4.3).** The declaration writes one doc_flow
  `DECLARES` edge onto its source delivery's **601 GI** (`inventory.goods_movement` — the delivery wrapper
  adopts that GI's `GM-<year>` number). Rationale: 수출신고 precedes the invoice (보세반입 → 신고 → 수리 →
  선적), and 출고 없이 수출 없음 — the delivery always exists at 신고 time, the billing may not. `sourceDeliveryId`
  is REQUIRED; the service resolves it READ-ONLY to its `goods_movement_id` (and checks the company via its
  SO). The edge is a PLAIN string target — the doc_flow graph is generic (no FK, no cross-domain import).
- **HS / origin are SNAPSHOTTED onto each line at filing.** `hs_code` (관세 품목분류) + `origin_country`
  come from `material_trade` when the DTO omits them, copied onto the item for the legal immutability of the
  filed declaration. Additive nullable, NO DB CHECK (the §12 trade-hook convention) — a master
  re-classification never rewrites filed lines. `trade_direction` is STORED ONLY (defaults EXP; never drives
  anything).
- **`total_fob_amount` is computed exactly through kernel `Money`** (per-currency minor units; `export-
  declaration-calc.ts`, §5.4-tested). A line FOB amount with finer precision than the declaration currency
  allows (a decimal on KRW, >2 on USD) is a 400.
- **Consistency gate = SOFT, never blocks (`export-declaration-warnings.ts`, §5.4).** create ALWAYS
  proceeds and returns `warnings[]` ({severity, code, message}):
  - **G0** a stored `trade_direction` ≠ EXP → WARN (the document IS an export).
  - **G1** an item line with no HS code → WARN, per line.
  - **G2 (영세율 증빙)** — the declared delivery's downstream billing tax codes, resolved READ-ONLY (the
    GI→SO←billing relationship via `billing.sales_order_id`): all 영세율 (rate 0) → no warning · billing
    exists with a NULL **or** taxable (rate>0) line → **WARN** (영세율 is allowed ONLY by an explicit
    tax_code; NULL is grouped WITH taxable so a silently-untaxed export line no longer slips through) · no
    billing yet → **INFO** (신고가 인보이스보다 선행, 정상).
- **Read-only across domains.** delivery / sales_order / billing / billing_item / tax_code are READ-ONLY
  lookups (no SalesModule import, no writes into another domain). No FI ⇒ no `account_determination` keys,
  no `posting_key`, no idempotency gate (create is not idempotent — a retry is a visible duplicate).

## Key tables (migration 0016)
- `export_declaration` — §4.2 header, status ∈ SUBMITTED/ACCEPTED (CHECK); `company_code_id`,
  `customer_bp_id` (foreign buyer), `broker_bp_id` (관세사, nullable); `declaration_no` varchar(35) (UNI-PASS
  MRN, nullable until 수리); `currency` + `exchange_rate` (18,6, NULL domestic); `total_fob_amount` (18,4,
  ≥0); trade hooks `incoterm`/`trade_direction`/`ship_to_country`/`customs_office` (additive nullable, no DB
  CHECK); `doc_no` `ED-NNNNNN` (range `trade.export_declaration`, GLOBAL scope).
- `export_declaration_item` — material FK; `hs_code`/`origin_country` snapshot (nullable); `qty` (18,6) > 0,
  `uom`; `fob_amount` (18,4) ≥ 0; `net_weight` (18,6) nullable ≥ 0. Explicit FK name to the header.

## FI postings
- export-declaration → **none** (영세율 customs document). Its linkage is the doc_flow `DECLARES` edge onto
  the delivery's 601 GI, NOT a journal. (통관수수료 / 관세환급(duty-drawback) postings — Dr 관세환급금 미수금 /
  Cr 관세환급수익 with a §5.4 refund calc — are a later slice.)

## Domain events
- None of its own yet (no FI ⇒ no journal outbox event). UNI-PASS 수리 / 적하목록 events arrive with the
  integration `unipass-connector` slice.

## Permissions
`trade_compliance:export_declaration:{create,accept,read}` (declared on the controller; ADMIN `*` covers
them).
