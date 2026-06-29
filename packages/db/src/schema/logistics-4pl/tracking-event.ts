import { check, index, pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { documentItemColumns } from '../_shared/document';

/**
 * Tracking event (logistics-4pl.tracking-event = 화물추적) — an append-only OBSERVATION timeline hung off a
 * shipment (선적). Each row is ONE observed milestone (GATE_IN … DELIVERED) at a point in time.
 *
 * This is a LOG, not a document: no header, no doc_no, **no doc_flow edge** — lineage is the `shipment_id`
 * column + index alone. Rationale (§4.3 / §3-C.5): doc_flow is for *document-chain* drill-down (every existing
 * `source_id` is a document header PK), whereas tracking_event is a header-less, **high-volume partitioned/
 * archived** table (§3-C.5 names it alongside journal_line/bank_transaction) — writing a doc_flow edge per
 * event would balloon the graph with log noise and orphan on archive. The architecture data model itself keys
 * it by `shp_id` (line 137). A header-less line collection: `documentItemColumns` (id + line_no + audit-4),
 * `line_no` the intake order within the shipment (NOT the timeline order — that is `event_time`).
 *
 * **Posts NOTHING to FI** and NEVER touches the shipment status machine: an event neither reads nor writes
 * `shipment.status`, and `event_type` (the observation enum) is DISTINCT from `SHIPMENT_STATUS` and never
 * converted/synced to it, even where names overlap (DEPARTED/ARRIVED). `shipment_id` is a PLAIN uuid (no
 * cross-domain FK; same convention as freight_settlement / shipping_document_set) — the service resolves it
 * READ-ONLY (must exist + same company). The same `event_type` may recur (IN_TRANSIT per 환적), so there is
 * deliberately NO `(shipment_id, event_type)` unique — duplicates are legitimate.
 */

export const trackingEvent = pgTable(
  'tracking_event',
  {
    // §4.2 document item spine: id, line_no, audit-4. (No header — a header-less observation log.)
    ...documentItemColumns(),
    /**
     * The shipment (선적) this event is observed against — a PLAIN uuid (no cross-domain FK; the graph is
     * generic, same convention as freight_settlement.shipment_id). The service resolves it READ-ONLY.
     */
    shipmentId: uuid('shipment_id').notNull(),
    /** Observed milestone — TRACKING_EVENT_TYPE (shared `trackingEventTypeSchema`); SEPARATE from SHIPMENT_STATUS. */
    eventType: varchar('event_type', { length: 16 }).notNull(),
    /** Observation timestamp (시각까지) — when the event occurred, supplied by the caller (NOT server now()). */
    eventTime: timestamp('event_time', { withTimezone: true, mode: 'string' }).notNull(),
    /** 발생 장소 (port/terminal/city — UN/LOCODE or name), nullable. */
    location: varchar('location', { length: 128 }),
    /** Free description ("vessel berthed at PNC"), nullable. */
    description: varchar('description', { length: 256 }),
  },
  (t) => [
    unique('tracking_event_no_uq').on(t.shipmentId, t.lineNo),
    check(
      'tracking_event_type_ck',
      sql`${t.eventType} in ('GATE_IN', 'LOADED', 'DEPARTED', 'IN_TRANSIT', 'ARRIVED', 'DISCHARGED', 'GATE_OUT', 'DELIVERED')`,
    ),
    // Per-shipment chronological scan (the timeline read orders by event_time). Its (shipment_id, …) left
    // prefix ALSO serves plain shipment_id equality lookups, so no separate shipment_id-only index is added
    // (the unique (shipment_id, line_no) covers that prefix too) — deliberately omitted to avoid write
    // amplification on this high-volume / partitioned table (§3-C.5).
    index('tracking_event_time_idx').on(t.shipmentId, t.eventTime),
  ],
);
