# Domain: Trade & Compliance `trade-compliance`

> **SAP mapping:** GTS
> Loads automatically when working under `apps/api/src/domains/trade-compliance/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/trade-compliance.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `customs-declaration` 🟧 — **`export-declaration` (수출신고) + `import-declaration` (수입신고) shipped**
  (Phase 7 slices 1–2). Both non-posting.
- `letter-of-credit` · `fta-origin` · `hs-classification` · `duty-drawback` · `trade-document` ·
  `incoterms` · `compliance-screening` · `cargo-insurance` — later.

## Status
🟧 **In progress (Phase 7 slices 1–2: export-declaration 수출신고 / import-declaration 수입신고, migrations
0016–0017).** First real code in the domain. A 수출신고 is a **non-posting** customs document — a Korean
export is 영세율 (no output VAT, no export duty), so value already moved at SD billing; the declaration
**posts NOTHING to FI**. Its only linkage is a doc_flow `DECLARES` edge onto the exported delivery's **601
GI** (`inventory.goods_movement`). Lifecycle: **create (SUBMITTED) → accept (수리 → ACCEPTED)**, the latter
stamping the externally-issued 수출신고번호/MRN (captured as a manual string — the UNI-PASS connector is
**deferred** to the integration domain). **Deferred:** UNI-PASS 전자통관 connector (integration/unipass-
connector), 통관수수료/관세환급 (duty-drawback) postings, FTA origin / HS-classification against
`@erp/trade-data`, compliance-screening (SPL), L/C (MT700), and web screens (matches recent slices #16–#20 —
backend + tests only).

**Slice 2 (import-declaration 수입신고, migration 0017)** is the symmetric IMPORT leg — also **non-posting**,
but for a DIFFERENT reason: import accounting (관세 + 수입부가세 재고원가 배부) is the **landed-cost** document's
SOLE job, already booked at/after the GR. So the declaration's `customs_value` (과세가격) / `duty_amount`
(관세액) / `import_vat_amount` (수입부가세액) are legal RECORD fields — a posting here would double-count what
landed cost owns. Its only linkage is a doc_flow `DECLARES` edge onto the same **수입 GR** (a **101**
`inventory.goods_movement`) that landed cost capitalizes against — the mirror of export's `DECLARES`→601 GI.
Same lifecycle (create SUBMITTED → accept 수리 → ACCEPTED, the latter stamping 수입신고번호/MRN + 신고수리일).
**Deferred (import):** UNI-PASS 수입 connector, FTA 원산지 판정 (here it only RECORDS origin), 관세환급
(duty-drawback), 전략물자, 관세 감면, 보세운송 — all later slices. The slice does NOT touch landed cost / GR /
procurement code (read-only), fi-posting, or movement types.

> **Note:** the externally-issued 수출신고번호 / 수입신고번호 (UNI-PASS MRN) is a SEPARATE column
> (`declaration_no`) from the internal `doc_no` (ED-/IM-NNNNNN minted by NumberingService). You mint the
> latter; 관세청 issues the former.

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

### Import declaration (수입신고) — the symmetric leg
- **An import declaration posts NOTHING to FI — landed cost is the SOLE owner of import accounting.** A
  posting here would DOUBLE-COUNT: the landed-cost document (0013) already capitalizes 관세 + 부대비용 into
  inventory (Dr BSX / Dr PRD) and books 수입부가세 (Dr 부가세대급금 1350) + AP at/after the GR. So `customs_value`
  (과세가격, CIF) / `duty_amount` (관세액) / `import_vat_amount` (수입부가세액) on the declaration are legal
  **RECORD fields**, never journals. Creating an `import_declaration` IS the explicit 수입 declaration (never
  inferred from `trade_direction`, which is STORED ONLY, defaults IMP). A foreign declaration stamps
  `exchange_rate` (신고일 'M' rate) as an audit/report value only.
- **Physical lineage = the 수입 GR (101), NOT landed cost (§4.3).** The declaration writes one doc_flow
  `DECLARES` edge onto its source goods movement — a **101** `inventory.goods_movement`. It is the same
  physical receipt whose inventory VALUE landed cost capitalizes, but in the doc_flow graph landed cost's
  `CAPITALIZES` edges target the PO item — so the declaration's `DECLARES` is the ONLY edge on the
  goods_movement node. `sourceGoodsMovementId` is REQUIRED; the service resolves it READ-ONLY (must be a 101
  GR, company checked via its plant). PLAIN string target / plain uuid columns — no cross-domain FK
  (`source_goods_movement_id` on the header, `source_gr_item_ref` on the item, validated to belong to the GR).
  Anchoring to the GR (not landed cost) keeps lineage independent of whether landed cost has posted yet.
- **HS / origin SNAPSHOTTED per line at filing** — same convention as export (`material_trade` when omitted,
  additive nullable, immutable). The header carries an additional predominant `origin_country` trade hook.
- **Declared amounts are exact through kernel `Money`** (`import-declaration-calc.ts`, §5.4-tested):
  `sumCustomsValues` (per-currency minor units; over-precision → 400) and `expectedDutyAmount`
  (= Σ 과세가격 × 관세율 via `Money.percentage`). Comparison helpers parse canonical NUMERIC(18,4) via
  `Money.fromNumeric` (never `Money.of`, which rejects KRW `'1500.0000'`).
- **Consistency gate = SOFT, never blocks (`import-declaration-warnings.ts`, §5.4):** **G0** trade_direction ≠
  IMP → WARN · **G1** line with no HS → WARN (per line) · **G2** line with no 원산지 → WARN (per line —
  import-specific: 원산지 drives 관세율/FTA) · **G3a** Σ line 과세가격 ≠ header 과세가격 → WARN · **G3b** declared
  관세액 deviates from (과세가격 × 관세율) beyond 1% → **INFO** (참고용, 비차단; skipped unless every line declares
  a rate). Order G0 → G1 → G2 → G3a → G3b, deterministic.
- **Read-only across domains.** goods_movement / plant / material_trade are READ-ONLY lookups — NO landed
  cost / GR / procurement WRITES, no InventoryModule import. No FI ⇒ no posting_key, no idempotency gate.

## Key tables (migration 0016)
- `export_declaration` — §4.2 header, status ∈ SUBMITTED/ACCEPTED (CHECK); `company_code_id`,
  `customer_bp_id` (foreign buyer), `broker_bp_id` (관세사, nullable); `declaration_no` varchar(35) (UNI-PASS
  MRN, nullable until 수리); `currency` + `exchange_rate` (18,6, NULL domestic); `total_fob_amount` (18,4,
  ≥0); trade hooks `incoterm`/`trade_direction`/`ship_to_country`/`customs_office` (additive nullable, no DB
  CHECK); `doc_no` `ED-NNNNNN` (range `trade.export_declaration`, GLOBAL scope).
- `export_declaration_item` — material FK; `hs_code`/`origin_country` snapshot (nullable); `qty` (18,6) > 0,
  `uom`; `fob_amount` (18,4) ≥ 0; `net_weight` (18,6) nullable ≥ 0. Explicit FK name to the header.

## Key tables (migration 0017) — purely additive
- `import_declaration` — §4.2 header, status ∈ SUBMITTED/ACCEPTED (CHECK); `company_code_id`,
  `supplier_bp_id` (overseas vendor), `broker_bp_id` (관세사, nullable); `source_goods_movement_id` (the 수입
  GR — plain uuid, NO cross-domain FK); `declaration_no` varchar(35) (MRN, nullable until 수리),
  `declaration_date` (신고일), `acceptance_date` (신고수리일, nullable); `currency` + `exchange_rate` (18,6, NULL
  domestic); `customs_value`/`duty_amount`/`import_vat_amount` (18,4, ≥0 — RECORD fields, never posted); trade
  hooks `incoterm`/`trade_direction`/`origin_country`/`customs_office` (additive nullable, no DB CHECK);
  `doc_no` `IM-NNNNNN` (range `trade.import_declaration`, GLOBAL; doc_type `IM`).
- `import_declaration_item` — material FK; `source_gr_item_ref` (goods_movement_item, plain uuid, nullable);
  `hs_code`/`origin_country` snapshot (nullable); `qty` (18,6) > 0, `uom`; `customs_value` (18,4) ≥ 0;
  `duty_rate` (7,4) nullable ≥ 0. Explicit FK name to the header.

## FI postings
- export-declaration → **none** (영세율 customs document). Its linkage is the doc_flow `DECLARES` edge onto
  the delivery's 601 GI, NOT a journal. (통관수수료 / 관세환급(duty-drawback) postings — Dr 관세환급금 미수금 /
  Cr 관세환급수익 with a §5.4 refund calc — are a later slice.)
- import-declaration → **none** (RECORD document). Import accounting is the landed-cost document's job
  (Dr BSX/PRD + Dr 부가세대급금 1350 + Cr AP, at/after the GR); the declaration only writes a doc_flow `DECLARES`
  edge onto that same 수입 GR (101). Posting here would double-count — so it NEVER touches fi-posting.

## Domain events
- None of its own yet (no FI ⇒ no journal outbox event). UNI-PASS 수리 / 적하목록 events arrive with the
  integration `unipass-connector` slice.

## Permissions
`trade_compliance:export_declaration:{create,accept,read}` ·
`trade_compliance:import_declaration:{create,accept,read}` (declared on the controllers; ADMIN `*` covers
them).
