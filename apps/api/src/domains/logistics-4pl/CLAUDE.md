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
- `shipping-document` 🟧 — **선적 서류세트 (B/L·CI·PL) shipped** (Phase 8 slice 3, migration 0023). Non-posting;
  the trade shipping documents issued for a shipment, bundled (header metadata only) into an OPEN set + N lines.
- `cargo-tracking` 🟧 — **화물추적 (tracking event) shipped** (Phase 8 slice 4, migration 0024). Non-posting,
  header-less, append-only observation timeline hung off a shipment — INDEPENDENT of the shipment status machine.
- `carrier-booking` 🟧 — **운송수배 (carrier booking) shipped** (Phase 8 slice 5, migration 0026). Non-posting;
  a carrier (선사) reservation against a shipment (booking no. + cut-offs). The FIRST consumer of the `carrier` BP
  role (0025). INDEPENDENT of the shipment status machine.
- `freight-forwarding` (MBL/HBL/콘솔) · `logistics-billing` (화주 청구 + 예정/실제 accrual + 건별 마진) ·
  `transportation` · `control-tower` · `customs-brokerage` ·
  `3pl-warehouse` · `logistics-document` (full B/L·CI·PL content lines + PDF generation) — later.

## Status
🟧 **In progress (Phase 8 slice 5 shipped: carrier booking 운송수배, migration 0026; on top of slice 4's cargo
tracking 화물추적, migration 0024, slice 3's shipping document set 선적 서류세트, migration 0023, slice 2's freight
settlement 운임 정산, migration 0022, and slice 1's shipment 선적 backbone, migration 0021).** The **shipment** is the non-posting physical backbone — one transport
unit ("this cargo sails/flies out on this vessel/flight") bundling one or more **deliveries** (출고전표), forward-only
lifecycle **create (PLANNED) → book (BOOKED) → depart (DEPARTED) → arrive (ARRIVED)**.
**Freight settlement** is now the domain's **FIRST FI document**: a forwarder freight invoice hung off a shipment
raises an AP open item (one `KR` journal, **Dr 지급운임 / Cr 외상매입금**; the journal IS the AP document — no
ap_invoice table, exactly the landed-cost model). FX is delegated wholly to `JournalService.post` (the freight
service does no FX math); no VAT in v1 (a foreign forwarder's export freight is 국외제공용역/영세율). Payment is
left to the existing clearing slice.
**Shipping document set** is the domain's second non-posting physical document (like the shipment): the trade
shipping documents (B/L·CI·PL) issued for one shipment, bundled into an **OPEN** set + N document lines (kind /
number / 발행일 / 발행처). v1 records document **header metadata only** — no PDF generation, no per-document
content lines (CI 단가 / PL 포장명세). It **posts NOTHING** (no money/FX/currency); its only linkage is a doc_flow
**`DOCUMENTS`** edge → its shipment. A set opens OPEN and stays OPEN (완결/COMPLETED is deferred); `addDocument`
appends one line at a time (the B/L usually issues after the CI/PL, after 부킹).
**Cargo tracking** is the domain's third non-posting concern and the first that is NOT a document: an
append-only **observation timeline** of cargo milestones (GATE_IN … DELIVERED) hung off a shipment. It is
**INDEPENDENT of the shipment status machine** — an event never reads or writes `shipment.status`, and the
tracking enum (`TRACKING_EVENT_TYPE`) is a SEPARATE namespace from `SHIPMENT_STATUS` (never converted/synced,
even where names overlap like DEPARTED/ARRIVED). Header-less (no doc_no, no doc_flow edge, no numbering): lineage
is the `shipment_id` column alone, because `tracking_event` is a high-volume partitioned/archived log (§3-C.5),
not a document in the doc_flow chain. The same `event_type` may recur (IN_TRANSIT per 환적); the timeline reads
`event_time` asc (decoupled from `line_no`, which is intake order).
**Carrier booking** is the domain's fourth non-posting concern: a reservation placed with a carrier (선사) for a
shipment, registering the carrier's booking number and cut-off deadlines (cargo / 서류 / VGM, all nullable until
the carrier confirms). It is the **FIRST consumer of the `carrier` BP role (0025)** — `carrier_bp_id` is validated
to carry a carrier role (**no recon** — the carrier role is non-posting). It **posts NOTHING** (freight is the
separate freight_settlement) and **NEVER touches the shipment status machine** (PLANNED→BOOKED is
`shipment.book()`'s job — booking is a separate physical document). Its only linkage is a doc_flow **`BOOKS`** edge
→ its shipment. OPEN-only in v1; a shipment may hold multiple bookings (re-booking).
**Deferred (freight settlement):** per-charge-type cost-account split (v1 is ONE summed amount; no items table),
domestic 내륙운송 VAT, planned/estimated→actual freight accrual + per-shipment **sell/margin** (the 4PL heart),
freight-settlement cancel/reversal. **Deferred (shipping document set):** set 완결/COMPLETED transition, per-document
content lines (CI 단가 / PL 포장명세), document PDF generation/이메일 발송. **Deferred (cargo tracking):** automated
event ingestion (UNI-PASS 화물진행 / 선사 EDI — v1 is manual entry; the `source` provenance column lands with that
feed), milestone→status correlation, ETA recompute. **Deferred (carrier booking):** confirm/cancel transitions,
D/O (Delivery Order), container/seal/equipment/movement-type + items-level rows, VGM measured values, carrier-EDI
booking submission (v1 is manual registration). **Deferred (domain):** container/CBM optimization, WMS picking,
forwarder EDI — all later slices.

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
- **A shipping document set posts NOTHING to FI (non-posting physical record, like the shipment).** No
  `JournalService`, no account-determination, no `posting_key` use, no money/FX/currency columns — the invoice
  amount was already accounted at SD billing; the set only registers document numbers. `shipment_id` is a PLAIN
  uuid (no cross-domain FK); the service resolves it **READ-ONLY** (wrong-company → 400, unknown → 404). Its only
  linkage is one doc_flow **`DOCUMENTS`** edge → its shipment (source `logistics_4pl.shipping_document` → target
  `logistics_4pl.shipment`; physical lineage, NOT a POSTS edge, like 수출신고's DECLARES). A set is **OPEN**-only
  in v1; `create` opens it with 0+ lines and `addDocument` appends one line at the next `line_no` (a bounded
  retry absorbs a concurrent-append line_no race). `(doc_kind, doc_number)` is unique within a set — an in-payload
  dup → 400, a cross-call dup → 409. `doc_kind` ∈ BL/CI/PL (shared `shippingDocKindSchema` + DB CHECK).
- **A cargo tracking event posts NOTHING to FI and NEVER touches the shipment status machine.** A header-less,
  append-only observation log (no doc_no, no `posting_key`, no money/FX) — and crucially the two concepts are
  INDEPENDENT: an event neither reads nor writes `shipment.status`, and `TRACKING_EVENT_TYPE` (GATE_IN/LOADED/
  DEPARTED/IN_TRANSIT/ARRIVED/DISCHARGED/GATE_OUT/DELIVERED, shared schema + DB CHECK) is a SEPARATE enum from
  `SHIPMENT_STATUS`, never converted/synced even where names overlap. **No doc_flow edge and no numbering** —
  lineage is the `shipment_id` column + index alone (a high-volume partitioned/archived log, §3-C.5, must not
  write a doc_flow edge per event). `shipment_id` is a PLAIN uuid; the service resolves it READ-ONLY
  (wrong-company → 400, unknown → 404). The same `event_type` may recur (NO `(shipment_id, event_type)` unique);
  `line_no` is intake order (a bounded retry absorbs the concurrent-append race) while the timeline reads
  `event_time` asc.
- **A carrier booking posts NOTHING to FI and NEVER touches the shipment status machine.** It registers a carrier
  (선사) reservation (booking no. + cargo/서류/VGM cut-offs, all nullable) against a shipment — freight is the
  separate freight_settlement, so no `JournalService`/account-determination/`posting_key`/money/FX. Booking is a
  separate physical document from the shipment lifecycle: it never reads or writes `shipment.status` (that is
  `shipment.book()`'s job). `shipment_id` and `carrier_bp_id` are PLAIN uuids (no cross-domain FK); the service
  resolves BOTH READ-ONLY — the shipment (wrong-company → 400, unknown → 404) and the carrier BP, which must carry
  a `carrier` role (else 400; **NO recon substitution** — unlike freight's vendor role, the carrier role is
  non-posting and has no reconciliation account). The FIRST consumer of the `carrier` BP role (0025). One doc_flow
  **`BOOKS`** edge → its shipment (physical lineage, NOT a POSTS edge). **OPEN**-only in v1; NO `(shipment_id)` or
  `booking_no` unique — a shipment may be re-booked / hold multiple bookings.

## Key tables (migrations 0021, 0022, 0023, 0024, 0026)
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
- `shipping_document_set` (0023) — §4.2 header, **OPEN-only** (CHECK `in ('OPEN')`); `company_code_id` (FK);
  `shipment_id` (plain uuid, NO cross-domain FK — doc_flow carries lineage); `reference`/`header_text`; `doc_no`
  `SD-NNNNNN` (range `logistics.shipping_document`, GLOBAL; doc_type `SD`). No money/FX/currency columns
  (non-posting; the inherited `posting_key` spine column is unused, like the shipment's).
- `shipping_document_item` (0023) — `set_id` (explicit FK name `shipping_document_item_set_fk`); `doc_kind`
  varchar(2) (CHECK ∈ BL/CI/PL); `doc_number` varchar(64); `issue_date` (nullable)/`issuer_text` (nullable);
  `unique(set_id, line_no)` + `unique(set_id, doc_kind, doc_number)`.
- `tracking_event` (0024) — **header-less** observation log (`documentItemColumns`: id + line_no + audit-4 only;
  NO doc_no/doc_type/posting_key). `shipment_id` (plain uuid, NO cross-domain FK — and NO doc_flow edge);
  `event_type` varchar(16) (CHECK ∈ GATE_IN/LOADED/DEPARTED/IN_TRANSIT/ARRIVED/DISCHARGED/GATE_OUT/DELIVERED);
  `event_time` timestamptz (caller-supplied observation time); `location`/`description` (both nullable).
  `unique(shipment_id, line_no)` (NO `(shipment_id, event_type)` unique — duplicates legitimate); ONE index
  `(shipment_id, event_time)` for the chronological timeline (its left prefix also serves `shipment_id` lookups,
  so no separate `shipment_id`-only index — §3-C.5 write-amplification). No money/FX/currency columns.
- `carrier_booking` (0026) — §4.2 header, **OPEN-only** (CHECK `in ('OPEN')`); `company_code_id` (FK);
  `shipment_id` + `carrier_bp_id` (both plain uuid, NO cross-domain FK — doc_flow + service-side validation carry
  the relationships); `booking_no` varchar(64); `cargo_cutoff`/`doc_cutoff`/`vgm_cutoff` timestamptz (all
  nullable); `reference`/`header_text`; `doc_no` `CB-NNNNNN` (range `logistics.carrier_booking`, GLOBAL; doc_type
  `CB`). No money/FX/currency columns (non-posting; inherited `posting_key` unused). NO unique on `shipment_id` or
  `booking_no` (re-booking allowed). The carrier BP role itself is `master-data` migration 0025.

## FI postings
- shipment → **none** (physical document); its linkage is the doc_flow `CONTAINS` edge per delivery.
- shipping document set → **none** (physical record); its linkage is the doc_flow `DOCUMENTS` edge → its shipment.
- cargo tracking event → **none** (observation log); NO doc_flow edge at all — lineage is the `shipment_id` column.
- carrier booking → **none** (reservation document); its linkage is the doc_flow `BOOKS` edge → its shipment.
- freight settlement → `KR` via `JournalService.post(…, { tx })`: **Dr 지급운임 (FREIGHT) / Cr AP recon (gross,
  +forwarder partner)**. A FOREIGN invoice translates at the document-date 'M' rate (or `fxRate` override) —
  recon leg carries its functional amount, so it ties out in both currencies (no FX_ROUNDING). Lineage:
  freight_settlement —SETTLES→ shipment, —POSTS→ journal (subledger-owned → FI reverse refused).
- AP payment — NOT here: the existing clearing slice (`KZ`) settles the KR open item like any vendor invoice.

## Domain events
- shipment → none. shipping document set → none (non-posting). cargo tracking event → none (an observation log
  emits no domain event of its own in v1). carrier booking → none (non-posting). freight settlement → none of its
  own; its value-moving fact rides the journal outbox event (`finance.journal.posted`, same tx). Margin events
  arrive with later slices.

## Permissions
`logistics_4pl:shipment:{create,book,depart,arrive,read}` ·
`logistics_4pl:freight_settlement:{post,read}` ·
`logistics_4pl:shipping_document:{create,read}` ·
`logistics_4pl:tracking_event:{create,read}` ·
`logistics_4pl:carrier_booking:{create,read}` (declared on the controllers; ADMIN `*` covers them).
