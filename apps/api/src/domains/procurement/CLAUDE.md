# Domain: Procurement `procurement`

> **SAP mapping:** MM-Purchasing + SRM
> Loads automatically when working under `apps/api/src/domains/procurement/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/procurement.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `purchase-order` ✅ — PO header+items (commitment step, no FI)
- `goods-receipt` ✅ — GR against a PO, REUSING the inventory goods-movement engine (101 → WRX)
- `invoice-verification` ✅ — 3-way match → GR/IR relief + the AP open item
- `landed-cost` ✅ — 수입 부대비용 재고원가 배부 + 수입부가세 (value-only revaluation → Dr BSX/PRD, Dr 부가세대급금, Cr AP)
- `purchase-requisition` · `vendor-management` · `rfq` · `contract` — later

## Status
🟧 **In progress (Phase 3 slice 4 shipped: landed cost + 수입부가세, migration 0013; on top of slice
3's foreign-currency import PO + GR/IR FX + realized FX, migration 0012; slice 2's P2P PO→GR→IV +
GR/IR clearing, migration 0011).**
Landed cost now works: a forwarder/관세사 cost invoice capitalizes 관세·운임·보험·통관수수료 onto the
received stock as a **value-only revaluation** (no goods movement; Dr BSX covered share / Dr PRD
재고원가차이 for the already-issued share / Cr AP recon), and books customs-paid **import VAT** directly
to 부가세대급금 (NOT capitalized). One `KR` journal, one document; a foreign cost invoice translates AP
at the document-date rate with the residue to realized FX (9810/9820). **Deferred (landed cost):**
planned/PO-condition delivery costs (estimate-at-GR accrual), HS-code/duty auto-calc (trade-compliance
Phase 7), weight/volume allocation bases (v1 is received-value proportional), multi-PO / multi-currency
landed cost (v1 = one PO per document, import VAT functional-currency only), per-charge-type breakdown,
and landed-cost cancel/reversal.
Import (foreign-currency) procurement now works: a foreign PO's GR values stock in KRW at the
**GR-date** 'M' rate (Option P — the goods-movement engine stays functional-currency-only; the GR
orchestrator pre-translates), and the IV relieves GR/IR at that GR-date functional value and books
the GR↔invoice rate difference to **realized FX gain/loss** (reusing the clearing #13 keys
9810/9820). Deferred (procurement, beyond the landed-cost list above): **partial / multi-document
foreign IV** (v1 import IV is FULL-match only), the PO exchange-rate-fixed (KUFIX) toggle, PR approval
workflow, PRD price-difference posting + MAP revaluation on IV price variance (Option A today — see
below), GR/IV **cancel/reversal** (102/202 + IV credit memo), PO change/close lifecycle,
per-valuation-class WRX, tolerance keys in admin-config (constants today), delivery-completed flag,
multi-PO IV, account-assigned (non-stock) POs, UI screens, OpenAPI registry entries.

> **Note:** GR→IV 3-way match. Import POs feed landed-cost (cross-cutting) into inventory +
> product-costing (the NEXT slice).

## Domain rules
- **A PO posts NOTHING to FI.** It is the commitment; value moves at GR (stock + GR/IR) and IV
  (GR/IR relief + AP). A PO may be **FOREIGN-currency (import)**: the currency only has to exist in
  the currency master (validated at PO creation); the rate is resolved at GR/IV time. A domestic PO
  stays in the company functional currency.
- **GR is not a new engine.** `GoodsReceiptService` builds a movement-type-**101** document priced at
  the **PO unit price** and calls `GoodsMovementService.post(dto, actor, opts)` with
  `opts.offsetKey = 'WRX'` — so stock + valuation + the WE journal (**Dr BSX / Cr WRX**) + PO lineage
  commit in ONE transaction (the §5.2 guarantee lives in the movement engine). Never write a parallel
  GR document store. **Import GR (Option P):** the movement engine values stock ONLY in the functional
  currency (the `material_valuation` KRW invariant), so the orchestrator translates the foreign unit
  price to KRW at the **GR-date** 'M' rate BEFORE the engine (KRW in → KRW out, engine unchanged;
  `import-valuation.ts` is the §5.4-tested pure translation) and stamps the foreign trade trace
  (`document_currency` / `exchange_rate` / `document_amount`) on each `goods_movement_item`. The GR
  journal is a plain KRW document; a domestic GR is byte-identical to before.
- **Receipt/invoice progress is DERIVED, never a stored flag (D4).** Received qty/value = the
  `RECEIVES` doc_flow edges (`inventory.goods_movement_item` → `procurement.purchase_order_item`)
  joined to `goods_movement_item`; invoiced qty/value = `invoice_verification_item` rows. GRNI
  (입고미착 잔액) per PO item = received − invoiced, in qty AND value
  (`GET /procurement/purchase-orders/:id/gr-ir`). No counters to drift.
- **3-way match is pure math** (`invoice-verification/three-way-match.ts`, §5.4 unit-tested):
  quantity — an invoice may bill only `Σreceived − Σinvoiced` (+ tolerance, default 0); price —
  within ±1% (bp) or an absolute tolerance of the PO price, whichever is larger. Violations → 400
  with all line reasons. Tolerances are constants this slice (admin-config later).
- **GR/IR (WRX) self-clears as a Cr/Dr pair — no clearing document.** GR credits WRX at the PO
  price; IV debits WRX at the **invoiced net** (Option A). An exact price match nets the pair to
  zero only when the GR and IV quantities **align**: because each partial GR/IV line is valued and
  rounded independently to the functional minor unit, asymmetric partial splits on a fractional unit
  price leave a GR/IR rounding residue (≈½ a minor unit per partial line — a few units across many
  partials), and an in-tolerance price variance leaves a larger WRX residue. Both are genuine GR/IR
  dust — every journal stays balanced and inventory↔GL recon stays `0` regardless — cleared by the
  follow-up PRD/MR11 slice (Option B). One WRX account (wildcard valuation class) so the pair always
  meets on the same account.
- **Import (foreign) IV → realized FX (REUSE clearing #13).** A foreign IV relieves WRX at the
  **GR-date functional value** (the GR-booked KRW, read from the received aggregate `amount`),
  translates the AP + VAT legs at the **invoice-date** 'M' rate (per-line `functionalAmount`
  overrides), and routes the functional residue to `REALIZED_FX_GAIN` (credit) / `REALIZED_FX_LOSS`
  (debit) — 9810/9820, `currency = null`, the same keys clearing uses. WRX therefore extinguishes to
  **exactly zero** in the functional currency; the GR↔invoice rate difference is isolated outside WRX.
  The journal ties out in BOTH the document currency (invoice currency) and the functional currency,
  so `post()`'s FX_ROUNDING auto-plug never fires. v1 import IV is **full-match only** (each PO item
  invoiced once, in full — so the relief is the whole GR functional, no partial-rate apportioning).
  The 3-way match compares foreign price-to-price (FX-neutral; the FX difference is never a match
  exception). The GR/IR open report shows a foreign PO's open value in the PO (document) currency.
- **IV posts through `JournalService.post(…, { tx })`** — IV header/items + the `KR` journal +
  doc_flow edges commit atomically. It REUSES the AP primitives from #11: recon-account substitution
  from the vendor role, the shared tax-line builder (D1/D2, INPUT VAT), and the open-item model —
  **the AP open item IS the KR journal** (D4, no second store), so clearing #13 pays it unchanged.
- **IV journals are subledger-owned:** the IV links a `POSTS` doc_flow edge onto its KR journal, so
  `JournalService.reverse()` refuses it (same fence as goods movements). Correction = a future
  IV-cancel that unwinds the matching record too, never a bare GL reversal (GR/IR would drift).
- **Idempotency (§5.2):** PO create is not idempotent (no posting; client retries are visible
  duplicates by docNo). GR rides the movement's (plant, posting_key) gate — the GR service skips its
  over-delivery pre-check on a replayed key (the derived received qty already includes that receipt).
  IV has its own NOT NULL `posting_key`, UNIQUE per company; replay returns the stored document; the
  journal key is `iv:<header uuid>` (per-document, like `gm:<uuid>`).
- **Over-delivery guard:** Σreceived + this GR ≤ ordered (+ tolerance, default 0) per PO item —
  best-effort pre-check (advisory; FI/GR-IR integrity never depends on it). A GR receives lines of
  ONE plant (a movement is single-plant); multi-plant POs split into separate GRs.
- **Landed cost = a value-only revaluation, NOT a goods movement.** `LandedCostService` allocates one
  cost-invoice total across the PO's received lines by **received functional value** (largest-remainder,
  line_no tie-break — `landed-cost-allocation.ts`, §5.4-tested; Σ shares == total exactly), translates
  a foreign cost to KRW first (Option-P), then calls the inventory engine's **`revaluateValue(…, tx)`**
  which — under the same `material_valuation` SELECT FOR UPDATE lock — adds the on-hand-**covered** share
  to `stock_value` (Dr BSX, MAP re-derived on the UNCHANGED qty) and expenses the **uncovered** share
  (stock already issued) to PRD 재고원가차이. There is NO planned accrual / cost-type clearing (single
  actual-cost document). **Import VAT** is supplied directly from the 수입세금계산서 (base = CIF+관세),
  posted Dr 부가세대급금 1350 — **never capitalized**, never via `buildTaxLines`, and only valid on a
  functional-currency document (a foreign forwarder invoice carries no customs VAT). Idempotent on
  `posting_key` (gate `landed_cost_posting_key_uq`); journal key `lc:<header uuid>`; the landed_cost
  **POSTS** its journal (subledger-owned → FI reverse refused; correction is a future landed-cost-cancel).

## Key tables (migrations 0011, 0012)
- `purchase_order` — §4.2 header; status ∈ ORDERED/CLOSED; vendor_bp_id; `currency` (functional OR a
  foreign import currency); `doc_no` `PO-NNNNNN` (range `procurement.purchase_order`, GLOBAL scope).
- `purchase_order_item` — material, plant + storage location (composite FK pins sloc→plant),
  ordered_qty (18,6) > 0, unit_price (18,6) ≥ 0 (in the PO currency), optional INPUT tax_code.
- `invoice_verification` — §4.2 header, tightened: POSTED-only, posting_key NN UNIQUE(company);
  one PO per IV; `exchange_rate` (18,6, NULL domestic — applied 'M' rate of a foreign invoice, 0012);
  `doc_no` `IV-NNNNNN` (range `procurement.invoice_verification`, GLOBAL scope).
- `invoice_verification_item` — PO-item FK, invoiced_qty (18,6) > 0, invoice_unit_price (18,6),
  amount (18,4) = invoiced net in the DOCUMENT currency (the WRX debit base). FK names are EXPLICIT
  (auto names exceeded Postgres's 63-char limit).
- `goods_movement_item` (inventory table) gains the import trade trace `document_currency` /
  `exchange_rate` / `document_amount` (all NULL domestic, 0012) — the foreign basis of an import GR.
- No GR table — a GR IS a `goods_movement` (+ doc_flow lineage).
- `landed_cost` (migration 0013) — §4.2 header, POSTED-only, `posting_key` NN UNIQUE(company);
  vendor_bp_id (forwarder/관세사), one `purchase_order_id`; `currency` (document, foreign-allowed) +
  `exchange_rate` (18,6, NULL domestic); `cost_amount` (document ccy), `import_vat_amount` (KRW, →1350,
  NOT capitalized), `vat_tax_code`, `import_declaration_no` (수입신고번호, 세관 VAT counterparty);
  `doc_no` `LC-NNNNNN` (range `procurement.landed_cost`, GLOBAL). The AP open item it raises is the
  `KR` journal (D4), paid by clearing #13.
- `landed_cost_item` — per received-PO-line capitalization: material+plant target, purchase_order_item
  FK, `received_functional_value` (basis), `capitalized_share` = `covered_share` + `prd_amount` (CHECK),
  all functional (KRW). Explicit FK names (auto names exceed 63 chars).

## FI postings
- PO → none.
- GR (domestic) → `WE` via the goods-movement engine: **Dr BSX (stock) / Cr WRX (GR/IR)**, qty × PO
  price, functional currency; lineage `goods_movement` —RECEIVES→ `purchase_order` (+ per-item edges).
- GR (import) → `WE`, same engine, a **KRW** document: stock/WRX = qty × (foreign price × GR-date
  rate); the foreign trade trace rides `goods_movement_item`.
- IV (domestic) → `KR` via fi-posting (caller-tx): **Dr WRX (invoiced net, per line) / Dr input VAT
  (Σ per tax code) / Cr AP recon (gross, +vendor partner)**; lineage IV —INVOICES→ PO, IV —POSTS→ journal.
- IV (import) → `KR`, document currency = invoice currency: **Dr WRX (GR-date functional) / Dr input
  VAT (rare — customs-paid) / Cr AP recon (invoice-rate functional) / Dr·Cr realized FX (residue →
  9810/9820)**. WRX nets to zero in the functional currency; the FX difference is the realized gain/loss.
- AP payment — NOT here: clearing #13 (`KZ`) settles the IV's open item like any vendor invoice
  (foreign items recognize realized FX again at the settlement rate).
- Landed cost (domestic) → `KR` via the inventory `revaluateValue` (caller-tx): **Dr BSX (covered cost
  share, value-only) / Dr PRD 재고원가차이 (uncovered share) / Dr 부가세대급금 (import VAT) / Cr AP recon
  (gross, +forwarder/관세사 partner)**; lineage landed_cost —CAPITALIZES→ PO items, —POSTS→ journal. The
  Dr BSX amount IS the `stock_value` delta, so Σ stock_value == BSX recon stays 0; import VAT touches
  only 1350.
- Landed cost (import / foreign cost invoice) → `KR`, document currency: **Dr BSX / Dr PRD (functional
  KRW via per-line functionalAmount) / Cr AP recon (document ccy, invoice-rate functional) / Dr·Cr
  realized FX (per-line translation residue → 9810/9820)**; ties out in both currencies so FX_ROUNDING
  never fires. Import VAT is 0 here (customs VAT rides the separate KRW 관세사 settlement).

## Domain events
- None of its own yet: GR rides the movement path; IV's value-moving fact rides the journal outbox
  event (`finance.journal.posted`, reference `procurement.invoice_verification:<docNo>`, same tx).

## Permissions
`procurement:purchase_order:{create,read}` · `procurement:goods_receipt:{post,read}` ·
`procurement:invoice_verification:{post,read}` · `procurement:landed_cost:{post,read}`
(declared on controllers; ADMIN `*` covers them.)
