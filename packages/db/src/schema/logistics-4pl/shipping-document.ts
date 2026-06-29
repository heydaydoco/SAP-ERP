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
 * Shipping document set (logistics-4pl.shipping-document = 선적 서류세트) — the trade shipping documents
 * (B/L, Commercial Invoice, Packing List) issued for one shipment (선적), bundled into one "set" of document
 * lines for registration + tracking. v1 records document HEADER metadata only (kind / number / 발행일 / 발행처)
 * — it does NOT generate the document PDFs, nor model the per-document content lines (CI 단가 lines, PL 포장
 * 명세 lines are a later slice).
 *
 * **Posts NOTHING to FI** — a 서류세트 is a PHYSICAL record, exactly like the customs declaration / shipment:
 * it moves no value (the invoice amount was already accounted at SD billing; the set registers document
 * numbers, it never points at or re-books that value). So this slice never touches fi-posting — no money / FX /
 * currency columns, no account_determination, no `posting_key` (an unused inherited column, like the shipment's).
 * Its only linkage is a doc_flow `DOCUMENTS` edge → its shipment (the physical lineage of "this is the document
 * set for that 선적"), exactly the non-posting lineage shape of export_declaration's DECLARES / shipment's
 * CONTAINS — NOT a POSTS edge.
 *
 * `shipment_id` is a PLAIN uuid (no cross-domain FK; the doc_flow graph is generic, same convention as
 * freight_settlement.shipment_id / shipment_item.delivery_id); the service resolves it READ-ONLY (must exist +
 * same company). A set opens OPEN and stays OPEN in v1 (set-完결 / COMPLETED transition is a later slice) — it
 * is an open bundle that document lines keep getting added to (addDocument), since the B/L usually issues after
 * the CI/PL (after 부킹).
 */

export const shippingDocumentSet = pgTable(
  'shipping_document_set',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key (unused — non-posting), audit-4.
    ...documentHeaderColumns(),
    /** A set opens OPEN and stays OPEN in v1 (완결/COMPLETED transition is a later slice). */
    status: varchar('status', { length: 16 }).notNull().default('OPEN'),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /**
     * The shipment (선적) this set documents — a PLAIN uuid (no cross-domain FK; the doc_flow `DOCUMENTS`
     * edge carries lineage, the graph is generic — same convention as freight_settlement.shipment_id). The
     * service resolves it READ-ONLY (must exist and belong to this company).
     */
    shipmentId: uuid('shipment_id').notNull(),
    /** Free reference (set memo / forwarder job no.), optional. */
    reference: varchar('reference', { length: 128 }),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('shipping_document_set_doc_no_uq').on(t.docNo),
    check('shipping_document_set_status_ck', sql`${t.status} in ('OPEN')`),
    index('shipping_document_set_company_idx').on(t.companyCodeId),
    index('shipping_document_set_shipment_idx').on(t.shipmentId),
  ],
);

export const shippingDocumentItem = pgTable(
  'shipping_document_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    setId: uuid('set_id').notNull(),
    /** Document kind — BL (선하증권/AWB) / CI (상업송장) / PL (포장명세서) (shared `shippingDocKindSchema`). */
    docKind: varchar('doc_kind', { length: 2 }).notNull(),
    /** The document's own number (B/L no., invoice no., packing-list no.). */
    docNumber: varchar('doc_number', { length: 64 }).notNull(),
    /** 발행일 — nullable (a document may be registered before it is issued). */
    issueDate: date('issue_date', { mode: 'string' }),
    /** 발행처 — free text (carrier / shipper / forwarder), nullable. */
    issuerText: varchar('issuer_text', { length: 128 }),
  },
  (t) => [
    unique('shipping_document_item_no_uq').on(t.setId, t.lineNo),
    // The same (kind, number) twice in one set is a mistake (registering the same B/L twice).
    unique('shipping_document_item_kind_number_uq').on(t.setId, t.docKind, t.docNumber),
    check('shipping_document_item_kind_ck', sql`${t.docKind} in ('BL', 'CI', 'PL')`),
    // Item→header FK with an explicit name (auto names can exceed Postgres's 63-char limit and silently
    // truncate, drifting the Drizzle snapshot) — same as shipment_item / export_declaration_item.
    foreignKey({
      name: 'shipping_document_item_set_fk',
      columns: [t.setId],
      foreignColumns: [shippingDocumentSet.id],
    }),
    index('shipping_document_item_set_idx').on(t.setId),
  ],
);
