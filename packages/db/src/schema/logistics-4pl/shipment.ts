import {
  check,
  date,
  foreignKey,
  index,
  pgTable,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { companyCode } from '../platform/org-structure';

/**
 * Shipment (logistics-4pl.shipment = SAP TM/forwarding essence) — the FIRST document of the 4PL logistics
 * domain and its backbone: one physical transport unit ("this cargo sails/flies out on this vessel/flight").
 * Freight settlement, tracking, and shipping documents are LATER slices that hang off this shipment.
 *
 * **Posts NOTHING to FI** — a shipment is a PHYSICAL document, exactly like the customs declaration: value
 * (freight) is recognized only when a logistics_charge attaches (a later slice). So this slice never touches
 * fi-posting. Its only linkage is a doc_flow `CONTAINS` edge per delivery it carries (the multi-edge loop
 * pattern of landed-cost CAPITALIZES / drawback REFUNDS).
 *
 * Lineage = the DELIVERY, not the GI. A `delivery` already wraps its 601 GI 1:1 and carries the SO / plant /
 * ship-to context, so a shipment line references `delivery.id` (a PLAIN uuid — no cross-domain FK, the
 * doc_flow graph is generic, same convention as 수출신고's GI reference). One shipment ↔ N deliveries
 * (consolidation; N=1 is the single-delivery shipment as a special case — drawback's header↔N-source pattern).
 * The same delivery's GI is what export_declaration anchors its `DECLARES` edge to, so shipment ↔ 신고 are
 * tied through one shared physical truth (different doc_flow nodes, same delivery/GI).
 *
 * Lifecycle is thin and forward-only: PLANNED → BOOKED (carrier/운송서류 confirmed) → DEPARTED (출항) →
 * ARRIVED (도착). SEA and AIR share one model — the `transport_mode` enum absorbs the difference, and B/L
 * (해상) / AWB (항공) collapse into the single `transport_doc_no`, 항차/편명 into `vessel_flight_no`.
 */

export const shipment = pgTable(
  'shipment',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A shipment is created PLANNED; book/depart/arrive flip it forward (terminal ARRIVED). */
    status: varchar('status', { length: 16 }).notNull().default('PLANNED'),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** 운송모드 — SEA/AIR/RAIL/TRUCK (shared `transportModeSchema`); v1 use is SEA/AIR. */
    transportMode: varchar('transport_mode', { length: 8 }).notNull(),
    /** 선사/항공사 (carrier) — a plain name string in v1 (BP modeling is a later slice). */
    carrier: varchar('carrier', { length: 128 }),
    /** 항차/편명 (vessel voyage / flight no), unified across SEA/AIR. */
    vesselFlightNo: varchar('vessel_flight_no', { length: 64 }),
    /** 운송서류번호 — B/L (해상) or AWB (항공), unified. NULL until 부킹(BOOKED). */
    transportDocNo: varchar('transport_doc_no', { length: 35 }),
    /** 출발항 (port/airport of loading) — UN/LOCODE or name. */
    portOfLoading: varchar('port_of_loading', { length: 64 }),
    /** 도착항 (port/airport of discharge) — UN/LOCODE or name. */
    portOfDischarge: varchar('port_of_discharge', { length: 64 }),
    /** 예정 출항일 (estimated time of departure). */
    etd: date('etd', { mode: 'string' }),
    /** 예정 도착일 (estimated time of arrival). */
    eta: date('eta', { mode: 'string' }),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('shipment_doc_no_uq').on(t.docNo),
    check('shipment_status_ck', sql`${t.status} in ('PLANNED', 'BOOKED', 'DEPARTED', 'ARRIVED')`),
    check('shipment_transport_mode_ck', sql`${t.transportMode} in ('SEA', 'AIR', 'RAIL', 'TRUCK')`),
    index('shipment_company_idx').on(t.companyCodeId),
    index('shipment_status_idx').on(t.status),
  ],
);

export const shipmentItem = pgTable(
  'shipment_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    shipmentId: uuid('shipment_id').notNull(),
    /**
     * The delivery (출고전표, `delivery.id`) this line carries — a PLAIN uuid (no cross-domain FK; the
     * doc_flow `CONTAINS` edge carries lineage, the graph is generic — same convention as 수입신고's
     * `source_goods_movement_id`). The service resolves it READ-ONLY (must belong to this company via its SO).
     */
    deliveryId: uuid('delivery_id').notNull(),
  },
  (t) => [
    unique('shipment_item_no_uq').on(t.shipmentId, t.lineNo),
    // One delivery appears at most once in a shipment (loading the same 출고 twice is meaningless). A delivery
    // shipping on at most ONE shipment (a global unique on delivery_id) is a stricter business rule — deferred.
    unique('shipment_item_delivery_uq').on(t.shipmentId, t.deliveryId),
    // Item→header FK with an explicit name (auto names can exceed Postgres's 63-char limit and silently
    // truncate, drifting the Drizzle snapshot) — same as export/import_declaration_item, drawback_claim_item.
    foreignKey({
      name: 'shipment_item_shipment_fk',
      columns: [t.shipmentId],
      foreignColumns: [shipment.id],
    }),
    index('shipment_item_shipment_idx').on(t.shipmentId),
    index('shipment_item_delivery_idx').on(t.deliveryId),
  ],
);
