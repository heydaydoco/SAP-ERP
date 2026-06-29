import { check, index, pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { documentHeaderColumns } from '../_shared/document';
import { companyCode } from '../platform/org-structure';

/**
 * Carrier booking (logistics-4pl.carrier-booking = 운송수배, SAP TM ocean-freight booking essence) — the
 * reservation placed with a carrier (선사) for a shipment, registering the carrier's booking number and its
 * cut-off deadlines. The FIRST consumer of the `carrier` BP role (migration 0025).
 *
 * **Posts NOTHING to FI** — a booking moves no value (freight is the separate freight_settlement document,
 * 0022). So this slice never touches fi-posting: no money/currency/FX columns, no account_determination, no
 * `posting_key` use (an unused inherited spine column, like the shipment / shipping-document set). Its only
 * linkage is a doc_flow `BOOKS` edge → its shipment (physical lineage, NOT a POSTS edge — like shipping-document's
 * DOCUMENTS).
 *
 * **Independent of the shipment status machine.** A booking never reads or writes `shipment.status` — the
 * PLANNED→BOOKED→DEPARTED→ARRIVED lifecycle is owned by the separate `shipment.book()` action. This document only
 * records the reservation's detail (number + cut-offs); it is its own physical record (same principle as cargo
 * tracking being independent of status).
 *
 * `shipment_id` and `carrier_bp_id` are PLAIN uuids (no cross-domain FK; the doc_flow graph is generic — same
 * convention as freight_settlement.shipment_id / forwarder_bp_id). The service resolves them READ-ONLY: the
 * shipment must exist + belong to this company, and the carrier BP must carry a `carrier` role (no recon
 * substitution — the carrier role is non-posting, it has no reconciliation account).
 *
 * Header-only (no items table): v1 is a header-level reservation. Container/seal/equipment/movement-type, D/O,
 * and VGM measured values are deferred to the 4PL forwarding slice / container backlog.
 */

export const carrierBooking = pgTable(
  'carrier_booking',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key (unused — non-posting), audit-4.
    ...documentHeaderColumns(),
    /** A booking opens OPEN and stays OPEN in v1 (confirm/cancel transitions are a later slice). */
    status: varchar('status', { length: 16 }).notNull().default('OPEN'),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /**
     * The shipment (선적) this booking is for — a PLAIN uuid (no cross-domain FK; the doc_flow `BOOKS` edge
     * carries lineage). Resolved READ-ONLY (must exist + same company). The shipment's status is never touched.
     */
    shipmentId: uuid('shipment_id').notNull(),
    /**
     * The carrier (선사/항공사) the booking is placed with — a PLAIN uuid (no cross-domain FK; BP is another
     * domain). Resolved READ-ONLY: the BP must carry a `carrier` role (no recon — non-posting). Same plain-uuid
     * convention as freight_settlement.forwarder_bp_id.
     */
    carrierBpId: uuid('carrier_bp_id').notNull(),
    /** The booking number the carrier issued. */
    bookingNo: varchar('booking_no', { length: 64 }).notNull(),
    /** 반입마감 (CY cut-off) — last time cargo must reach the load port. NULL until the carrier confirms it. */
    cargoCutoff: timestamp('cargo_cutoff', { withTimezone: true, mode: 'string' }),
    /** 서류마감 — Shipping Instruction submission deadline. NULL until confirmed. */
    docCutoff: timestamp('doc_cutoff', { withTimezone: true, mode: 'string' }),
    /** VGM 마감 (SOLAS) — verified-gross-mass submission deadline. NULL until confirmed. */
    vgmCutoff: timestamp('vgm_cutoff', { withTimezone: true, mode: 'string' }),
    /** Free reference (forwarder job no., etc.), optional. */
    reference: varchar('reference', { length: 128 }),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('carrier_booking_doc_no_uq').on(t.docNo),
    check('carrier_booking_status_ck', sql`${t.status} in ('OPEN')`),
    index('carrier_booking_company_idx').on(t.companyCodeId),
    index('carrier_booking_shipment_idx').on(t.shipmentId),
    index('carrier_booking_carrier_idx').on(t.carrierBpId),
    // NO unique on (shipment_id) — a shipment may be re-booked / hold multiple bookings (like shipping-document).
    // NO global unique on booking_no — different carriers may reuse a number; no v1 basis to forbid it.
  ],
);
