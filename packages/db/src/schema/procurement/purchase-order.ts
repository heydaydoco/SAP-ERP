import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { currencyCol, quantityCol } from '../_shared/columns';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { businessPartner } from '../master-data/business-partner';
import { material } from '../master-data/material';
import { companyCode, plant, purchasingOrg, storageLocation } from '../platform/org-structure';

/**
 * Purchase order (procurement.purchase-order = SAP MM EKKO/EKPO essence). The procurement commitment:
 * a vendor, ordered quantities at agreed prices. Extends the §4.2 document framework. A PO does NOT
 * post to FI — it is the obligation step; value moves only at goods receipt (GR → stock + GR/IR) and
 * invoice verification (IV → GR/IR relief + AP).
 *
 * Lifecycle is intentionally thin in this slice: ORDERED → CLOSED. Receipt/invoice **progress is
 * DERIVED**, never a stored flag (D4): received qty = the GR `RECEIVES` doc_flow edges into a PO
 * item; invoiced qty = the linked invoice_verification items. There is no `received`/`invoiced`
 * counter to drift. Foreign-currency (import) POs, landed cost, and PR approval are out of scope —
 * this slice is domestic, functional-currency procurement (the GR valuation currency MUST equal the
 * company functional currency).
 */

export const purchaseOrder = pgTable(
  'purchase_order',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A PO is created already ORDERED in this slice (no PR/approval step yet). */
    status: varchar('status', { length: 16 }).notNull().default('ORDERED'),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** The supplying business partner (must carry a vendor role). */
    vendorBpId: uuid('vendor_bp_id')
      .notNull()
      .references(() => businessPartner.id),
    /** Optional procuring organization (구매조직). */
    purchasingOrgId: uuid('purchasing_org_id').references(() => purchasingOrg.id),
    /** Order currency — equals the company functional currency in this slice (service-enforced). */
    currency: currencyCol('currency').notNull(),
    /** When the order was placed (business-event date). */
    orderDate: date('order_date', { mode: 'string' }).notNull(),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('purchase_order_doc_no_uq').on(t.docNo),
    check('purchase_order_status_ck', sql`${t.status} in ('ORDERED', 'CLOSED')`),
    index('purchase_order_vendor_idx').on(t.vendorBpId),
    index('purchase_order_company_idx').on(t.companyCodeId),
  ],
);

export const purchaseOrderItem = pgTable(
  'purchase_order_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    /** Receiving plant; GR posts a goods movement here (valuation view must exist at this plant). */
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    /** Receiving storage location (pinned to the plant by the composite FK below). */
    storageLocationId: uuid('storage_location_id').notNull(),
    /** Ordered quantity, NUMERIC(18,6); always positive. */
    orderedQty: quantityCol('ordered_qty').notNull(),
    /** Agreed net unit price (a rate — may be finer than the currency), NUMERIC(18,6). */
    unitPrice: numeric('unit_price', { precision: 18, scale: 6 }).notNull(),
    /** Equals the header currency (service-enforced). */
    currency: currencyCol('currency').notNull(),
    /** INPUT VAT code IV applies to this line's invoiced net (nullable for non-taxable). */
    taxCode: varchar('tax_code', { length: 16 }),
  },
  (t) => [
    unique('purchase_order_item_no_uq').on(t.purchaseOrderId, t.lineNo),
    check('purchase_order_item_qty_pos_ck', sql`${t.orderedQty} > 0`),
    check('purchase_order_item_price_nonneg_ck', sql`${t.unitPrice} >= 0`),
    // Existence AND plant-match in one constraint (targets storage_location_id_plant_uq), like `stock`.
    foreignKey({
      name: 'purchase_order_item_sloc_plant_fk',
      columns: [t.storageLocationId, t.plantId],
      foreignColumns: [storageLocation.id, storageLocation.plantId],
    }),
    index('purchase_order_item_po_idx').on(t.purchaseOrderId),
    index('purchase_order_item_material_idx').on(t.materialId),
  ],
);
