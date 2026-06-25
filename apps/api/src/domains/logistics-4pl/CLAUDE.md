# Domain: Logistics / 4PL `logistics-4pl`

> **SAP mapping:** TM (Transportation Management) / forwarding — 4PL (deepened core)
> Loads automatically when working under `apps/api/src/domains/logistics-4pl/`.
> Read the root `CLAUDE.md` first — global + structural + non-functional rules apply here too.
> Full spec (when written): `@docs/domains/logistics-4pl.md`. Domain map: `@docs/architecture-full.md`.

## Modules
- `shipment` 🟧 — **선적 backbone shipped** (Phase 8 slice 1, migration 0021). Non-posting; the physical
  transport unit every later 4PL concern hangs off.
- `freight-forwarding` / `logistics-billing` (운임·물류정산 — the domain's FIRST FI) · `transportation` ·
  `shipment-booking` · `cargo-tracking` · `control-tower` · `customs-brokerage` · `3pl-warehouse` ·
  `logistics-document` (B/L·CI·PL) — later.

## Status
🟧 **In progress (Phase 8 slice 1: shipment 선적, migration 0021).** First code in the domain and its
backbone. A shipment is one physical transport unit ("this cargo sails/flies out on this vessel/flight") that
bundles one or more **deliveries** (출고전표); every later 4PL concern (freight, tracking, documents, booking)
hangs off it. **Posts NOTHING to FI** — exactly like the customs declaration, a shipment is a PHYSICAL
document; value (freight) is recognized only when a `logistics_charge` attaches (a later slice). Lifecycle:
**create (PLANNED) → book (BOOKED) → depart (DEPARTED) → arrive (ARRIVED)**, forward-only.
**Deferred:** freight calc/settlement (the domain's first FI), real-time tracking, container/CBM optimization,
WMS picking, forwarder EDI, booking automation, document-set generation (B/L·CI·PL) — all later slices.

> **Note:** Heart of the system: per-shipment cost vs sell at charge granularity, planned→actual accrual,
> real-time margin → FI. Margin math needs Vitest unit tests (§5.4). Detail: @docs/domains/logistics-4pl.md.
> (This first slice is the non-posting shipment backbone only; the margin engine arrives with freight charges.)

## Domain rules
- **A shipment posts NOTHING to FI.** No `JournalService`, no account-determination, no `posting_key` — it
  imports only PlatformModule (`DocFlowService`) + NumberingModule. Freight accounting is a later slice.
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

## Key tables (migration 0021)
- `shipment` — §4.2 header, status ∈ PLANNED/BOOKED/DEPARTED/ARRIVED (CHECK); `company_code_id`;
  `transport_mode` (CHECK ∈ SEA/AIR/RAIL/TRUCK); `carrier`/`vessel_flight_no`/`transport_doc_no` (B/L·AWB,
  nullable until 부킹)/`port_of_loading`/`port_of_discharge`/`etd`/`eta` (all nullable); `doc_no` `SH-NNNNNN`
  (range `logistics.shipment`, GLOBAL; doc_type `SH`).
- `shipment_item` — `shipment_id` (explicit FK name to the header); `delivery_id` (plain uuid, NO cross-domain
  FK); `unique(shipment_id, line_no)` + `unique(shipment_id, delivery_id)`.

## FI postings
- shipment → **none** (physical document). Its linkage is the doc_flow `CONTAINS` edge per delivery, NOT a
  journal. Freight/4PL settlement (the domain's FIRST posting, per-shipment cost vs sell) is a later
  `logistics_charge` slice.

## Domain events
- shipment → none of its own yet (no FI). Tracking / freight events arrive with later slices.

## Permissions
`logistics_4pl:shipment:{create,book,depart,arrive,read}` (declared on the controller; ADMIN `*` covers them).
