# Domain: Logistics / 4PL `logistics-4pl`

> **SAP mapping:** TM (Transportation Management) / forwarding — 4PL (deepened core)
> Loads automatically when working under `apps/api/src/domains/logistics-4pl/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/logistics-4pl.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `shipment` 🟧 — **선적 backbone shipped** (Phase 8 slice 1, migration 0021). Non-posting; the physical
  transport unit every later 4PL concern hangs off.
- `freight-settlement` ✅ — **운임 정산 shipped** (Phase 8 slice 2, migration 0022). The domain's **FIRST FI** —
  a forwarder freight invoice hung off a shipment raises an AP open item (Dr 지급운임 / Cr AP recon), one `KR`
  journal (the journal IS the AP document, like landed-cost).
- `freight-forwarding` (MBL/HBL/콘솔) · `logistics-billing` (화주 청구 + 예정/실제 accrual + 건별 마진) ·
  `transportation` · `shipment-booking` · `cargo-tracking` · `control-tower` · `customs-brokerage` ·
  `3pl-warehouse` · `logistics-document` (B/L·CI·PL) — later.

## Status
🟧 **In progress (Phase 8 slice 2 shipped: freight settlement 운임 정산, migration 0022; on top of slice 1's
shipment 선적 backbone, migration 0021).** The **shipment** is the non-posting physical backbone — one transport
unit ("this cargo sails/flies out on this vessel/flight") bundling one or more **deliveries** (출고전표), forward-only
lifecycle **create (PLANNED) → book (BOOKED) → depart (DEPARTED) → arrive (ARRIVED)**.
**Freight settlement** is now the domain's **FIRST FI document**: a forwarder freight invoice hung off a shipment
raises an AP open item (one `KR` journal, **Dr 지급운임 / Cr 외상매입금**; the journal IS the AP document — no
ap_invoice table, exactly the landed-cost model). FX is delegated wholly to `JournalService.post` (the freight
service does no FX math); no VAT in v1 (a foreign forwarder's export freight is 국외제공용역/영세율). Payment is
left to the existing clearing slice.
**Deferred (freight settlement):** per-charge-type cost-account split (v1 is ONE summed amount; no items table),
domestic 내륙운송 VAT, planned/estimated→actual freight accrual + per-shipment **sell/margin** (the 4PL heart),
freight-settlement cancel/reversal. **Deferred (domain):** real-time tracking, container/CBM optimization, WMS
picking, forwarder EDI, booking automation, document-set generation (B/L·CI·PL) — all later slices.

> **Note:** Heart of the system: per-shipment cost vs sell at charge granularity, planned→actual accrual,
> real-time margin → FI. Margin math needs Vitest unit tests (§5.4). Detail: @docs/domains/logistics-4pl.md.
> (This first slice is the non-posting shipment backbone only; the margin engine arrives with freight charges.)

## Domain rules
- **A shipment posts NOTHING to FI.** No `JournalService`, no account-determination, no `posting_key` on the
  shipment itself. Freight accounting is a SEPARATE document (`freight-settlement`) that hangs off it.
- **Freight settlement is the domain's first FI — "the journal IS the AP document" (like landed-cost).** It
  calls `JournalService.post(docType='KR', { tx })` directly (no `ap_invoice` store): **Dr 지급운임**
  (account-determination `FREIGHT`, never hard-coded §4.5) / **Cr AP recon** (substituted from the forwarder's
  vendor role, `partnerId` = forwarder — never from the DTO). Exactly two lines; **no VAT in v1** (a foreign
  forwarder's export freight is 국외제공용역/영세율 — no deductible import VAT). Header-only (no items table): the
  forwarder invoice's ocean freight + THC + 내륙 arrive as ONE summed amount; per-charge split is a later slice.
- **The freight service does NO FX math — `JournalService.post` owns it all.** It resolves the document-date 'M'
  rate (or honors an explicit `fxRate` override) only to stamp `exchange_rate` on the header and put the
  functional amount on the recon leg, then passes `currency` + `fxRate` to `post`, which translates each line,
  ties out in both currencies, and (2-line entry, recon leg carries its functional amount) leaves no FX_ROUNDING
  residue. `exchange_rate` is NULL on a functional-currency invoice.
- **`shipment_id` is a PLAIN uuid (no cross-domain FK; the doc_flow graph is generic, like shipment's
  `delivery_id`).** The service resolves the shipment **READ-ONLY** — it must exist and belong to the same
  company (a wrong-company shipment → 400, an unknown one → 404); the shipment is never written.
- **Two doc_flow edges from a freight settlement (§4.3):** **`SETTLES`** → its shipment (lineage/drill-down,
  source `logistics_4pl.freight_settlement` → target `logistics_4pl.shipment`) and **`POSTS`** → its KR journal
  (target `finance.journal_entry`). `POSTS` is the literal the FI reverse-guard checks, so the KR journal is
  **subledger-owned** — `JournalService.reverse()` refuses it (same fence as landed-cost / IV); correction is a
  future freight-cancel, never a bare GL reversal. (`POSTS` is exactly one edge; `journalIdOf` finds it safely.)
- **Idempotency (§5.2):** `posting_key` NOT NULL UNIQUE per company (gate `freight_settlement_posting_key_uq`);
  a replay returns the stored document (no second journal). The journal key is `<freight key>:je` — a FRESH,
  per-document key (a caller-tx post must never reuse the freight key); the concurrent-duplicate loser blocks on
  the freight header insert and never reaches `post`, so no journal key collides. Default key `freight:<uuid>`.
- **Lineage = the DELIVERY, not the GI (§4.3).** A shipment line references `delivery.id` (a PLAIN uuid — no
  cross-domain FK; the doc_flow graph is generic, like 수입신고's GI reference), and the service writes one
  doc_flow **`CONTAINS`** edge per delivery (source `logistics_4pl.shipment` → target `sales.delivery`). The
  delivery wrapper carries the SO/plant/ship-to context; its GI is what 수출신고 anchors `DECLARES` to, so
  shipment ↔ 신고 share one physical truth (different nodes, same delivery/GI). **READ-ONLY** across domains:
  delivery / sales_order are looked up only (company checked via the delivery's SO — a delivery has no company
  column), never written; no SalesModule/InventoryModule import.
- **One shipment ↔ N deliveries (consolidation).** `unique(shipment_id, delivery_id)` (a delivery appears at
  most once per shipment); create rejects a duplicate `deliveryId` in the request. ⚠️ A delivery shipping on at
  most ONE shipment (a global unique on `delivery_id`) is **deferred** — accepted scope gap (mirrors drawback's
  deferred source-unique).
- **Forward-only lifecycle, atomic guards.** PLANNED → BOOKED → DEPARTED → ARRIVED, enforced by an atomic
  `UPDATE … WHERE status=<from>` flip per step (a wrong-state / concurrent transition updates 0 rows → 409,
  never skips or runs backwards). The order lives in `shipment-status.ts` (`nextShipmentStatus`, §5.4-tested).
- **SEA/AIR (and RAIL/TRUCK) share one model.** `transport_mode` (shared `transportModeSchema`, 4 modes;
  v1 use is SEA/AIR) absorbs the difference; B/L (해상) / AWB (항공) collapse into `transport_doc_no`, 항차/편명
  into `vessel_flight_no`. `carrier` is a plain string in v1 (BP modeling deferred). No money columns.

## Key tables (migrations 0021, 0022)
- `shipment` (0021) — §4.2 header, status ∈ PLANNED/BOOKED/DEPARTED/ARRIVED (CHECK); `company_code_id`;
  `transport_mode` (CHECK ∈ SEA/AIR/RAIL/TRUCK); `carrier`/`vessel_flight_no`/`transport_doc_no` (B/L·AWB,
  nullable until 부킹)/`port_of_loading`/`port_of_discharge`/`etd`/`eta` (all nullable); `doc_no` `SH-NNNNNN`
  (range `logistics.shipment`, GLOBAL; doc_type `SH`).
- `shipment_item` (0021) — `shipment_id` (explicit FK name to the header); `delivery_id` (plain uuid, NO
  cross-domain FK); `unique(shipment_id, line_no)` + `unique(shipment_id, delivery_id)`.
- `freight_settlement` (0022) — §4.2 header, **POSTED-only** (CHECK), `posting_key` NN UNIQUE(company);
  `company_code_id`; `shipment_id` (plain uuid, NO cross-domain FK — doc_flow carries lineage);
  `forwarder_bp_id` (vendor role; recon substituted from it); `currency` (document, foreign-allowed) +
  `exchange_rate` (18,6, NULL domestic); `freight_amount` (18,4, CHECK ≥ 0); `reference`/`header_text`;
  `doc_no` `FR-NNNNNN` (range `logistics.freight_settlement`, GLOBAL; doc_type `FR`). **No items table** (one
  summed amount in v1). The AP open item it raises is the `KR` journal (D4), paid by the clearing slice.

## FI postings
- shipment → **none** (physical document); its linkage is the doc_flow `CONTAINS` edge per delivery.
- freight settlement → `KR` via `JournalService.post(…, { tx })`: **Dr 지급운임 (FREIGHT) / Cr AP recon (gross,
  +forwarder partner)**. A FOREIGN invoice translates at the document-date 'M' rate (or `fxRate` override) —
  recon leg carries its functional amount, so it ties out in both currencies (no FX_ROUNDING). Lineage:
  freight_settlement —SETTLES→ shipment, —POSTS→ journal (subledger-owned → FI reverse refused).
- AP payment — NOT here: the existing clearing slice (`KZ`) settles the KR open item like any vendor invoice.

## Domain events
- shipment → none. freight settlement → none of its own; its value-moving fact rides the journal outbox event
  (`finance.journal.posted`, same tx). Tracking / margin events arrive with later slices.

## Permissions
`logistics_4pl:shipment:{create,book,depart,arrive,read}` ·
`logistics_4pl:freight_settlement:{post,read}` (declared on the controllers; ADMIN `*` covers them).
