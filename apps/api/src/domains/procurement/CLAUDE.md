# Domain: Procurement `procurement`

> **SAP mapping:** MM-Purchasing + SRM
> Loads automatically when working under `apps/api/src/domains/procurement/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/procurement.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `purchase-order` ✅ — PO header+items (commitment step, no FI)
- `goods-receipt` ✅ — GR against a PO, REUSING the inventory goods-movement engine (101 → WRX)
- `invoice-verification` ✅ — 3-way match → GR/IR relief + the AP open item
- `purchase-requisition` · `vendor-management` · `rfq` · `contract` — later

## Status
🟧 **In progress (Phase 3 slice 2 shipped: P2P PO→GR→IV + GR/IR clearing, migration 0011).**
Domestic (functional-currency) procurement only. Deferred: foreign-currency/import POs (+ GR/IR FX),
landed cost, PR approval workflow, PRD price-difference posting + MAP revaluation on IV price
variance (Option A today — see below), GR/IV **cancel/reversal** (102/202 + IV credit memo), PO
change/close lifecycle, per-valuation-class WRX, tolerance keys in admin-config (constants today),
delivery-completed flag, multi-PO IV, account-assigned (non-stock) POs, UI screens, OpenAPI registry
entries.

> **Note:** GR→IV 3-way match. Import POs feed landed-cost (cross-cutting) into inventory +
> product-costing (later slice).

## Domain rules
- **A PO posts NOTHING to FI.** It is the commitment; value moves at GR (stock + GR/IR) and IV
  (GR/IR relief + AP). PO currency MUST equal the company functional currency in this slice (GR
  valuates stock in functional currency — the `material_valuation` invariant).
- **GR is not a new engine.** `GoodsReceiptService` builds a movement-type-**101** document priced at
  the **PO unit price** and calls `GoodsMovementService.post(dto, actor, opts)` with
  `opts.offsetKey = 'WRX'` — so stock + valuation + the WE journal (**Dr BSX / Cr WRX**) + PO lineage
  commit in ONE transaction (the §5.2 guarantee lives in the movement engine). Never write a parallel
  GR document store.
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

## Key tables (migration 0011)
- `purchase_order` — §4.2 header; status ∈ ORDERED/CLOSED; vendor_bp_id; currency == functional;
  `doc_no` `PO-NNNNNN` (range `procurement.purchase_order`, GLOBAL scope).
- `purchase_order_item` — material, plant + storage location (composite FK pins sloc→plant),
  ordered_qty (18,6) > 0, unit_price (18,6) ≥ 0, optional INPUT tax_code.
- `invoice_verification` — §4.2 header, tightened: POSTED-only, posting_key NN UNIQUE(company);
  one PO per IV; `doc_no` `IV-NNNNNN` (range `procurement.invoice_verification`, GLOBAL scope).
- `invoice_verification_item` — PO-item FK, invoiced_qty (18,6) > 0, invoice_unit_price (18,6),
  amount (18,4) = invoiced net (the WRX debit base). FK names are EXPLICIT (auto names exceeded
  Postgres's 63-char limit).
- No GR table — a GR IS a `goods_movement` (+ doc_flow lineage).

## FI postings
- PO → none.
- GR → `WE` via the goods-movement engine: **Dr BSX (stock) / Cr WRX (GR/IR)**, qty × PO price,
  functional currency; lineage `goods_movement` —RECEIVES→ `purchase_order` (+ per-item edges).
- IV → `KR` via fi-posting (caller-tx): **Dr WRX (invoiced net, per line) / Dr input VAT (Σ per tax
  code) / Cr AP recon (gross, +vendor partner)**; lineage IV —INVOICES→ PO, IV —POSTS→ journal.
- AP payment — NOT here: clearing #13 (`KZ`) settles the IV's open item like any vendor invoice.

## Domain events
- None of its own yet: GR rides the movement path; IV's value-moving fact rides the journal outbox
  event (`finance.journal.posted`, reference `procurement.invoice_verification:<docNo>`, same tx).

## Permissions
`procurement:purchase_order:{create,read}` · `procurement:goods_receipt:{post,read}` ·
`procurement:invoice_verification:{post,read}` (declared on controllers; ADMIN `*` covers them.)
