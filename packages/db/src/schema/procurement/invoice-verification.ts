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
import { currencyCol, moneyCol, quantityCol } from '../_shared/columns';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { businessPartner } from '../master-data/business-partner';
import { companyCode } from '../platform/org-structure';
import { purchaseOrder, purchaseOrderItem } from './purchase-order';

/**
 * Invoice verification (procurement.invoice-verification = SAP MM-LIV / MIRO essence). The
 * 3-way-match document: it reconciles a vendor invoice against the PO and the goods received, then
 * raises the AP open item. It is the **matching/quantity record**; the AP open item itself is the
 * `KR` journal it posts (D4 — there is no second AP store, exactly like ar/ap invoices). So a posted
 * IV becomes a normal AP open item that the clearing slice (#13) pays.
 *
 * FI posting (functional-currency slice): **Dr GR/IR clearing (WRX)** relieves the goods-received
 * accrual, **Dr input VAT** per tax code, **Cr AP recon (+vendor partner)** the gross. GR credited
 * WRX at the PO price; IV debits WRX at the invoiced net (Option A), so a price-matched invoice
 * clears GR/IR to zero and any in-tolerance price variance leaves a small WRX residue (PRD price-
 * difference posting + stock revaluation are a follow-up). Posted-only + idempotent on `posting_key`.
 */

export const invoiceVerification = pgTable(
  'invoice_verification',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** An IV exists only once posted (no DRAFT; cancel/reversal is a follow-up slice). */
    status: varchar('status', { length: 16 }).notNull().default('POSTED'),
    /** Idempotency key (§5.2) — NOT NULL here; the UNIQUE below is the exactly-once gate. */
    postingKey: varchar('posting_key', { length: 128 }).notNull(),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    vendorBpId: uuid('vendor_bp_id')
      .notNull()
      .references(() => businessPartner.id),
    /** The PO this invoice verifies (one PO per IV in this slice). */
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id),
    /** Vendor invoice / 세금계산서 number. */
    reference: varchar('reference', { length: 128 }).notNull(),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    currency: currencyCol('currency').notNull(),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('invoice_verification_posting_key_uq').on(t.companyCodeId, t.postingKey),
    unique('invoice_verification_doc_no_uq').on(t.docNo),
    check('invoice_verification_status_ck', sql`${t.status} = 'POSTED'`),
    index('invoice_verification_po_idx').on(t.purchaseOrderId),
    index('invoice_verification_vendor_idx').on(t.vendorBpId),
  ],
);

export const invoiceVerificationItem = pgTable(
  'invoice_verification_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    // FKs declared below with explicit names: the auto-generated ones exceed Postgres's 63-char
    // identifier limit (the DB would silently truncate, drifting from the Drizzle snapshot).
    invoiceVerificationId: uuid('invoice_verification_id').notNull(),
    /** The PO item this line matches (the granularity 3-way match + GR/IR derivation work at). */
    purchaseOrderItemId: uuid('purchase_order_item_id').notNull(),
    /** Invoiced quantity, NUMERIC(18,6); positive. */
    invoicedQty: quantityCol('invoiced_qty').notNull(),
    /** Invoiced unit price (a rate), NUMERIC(18,6). */
    invoiceUnitPrice: numeric('invoice_unit_price', { precision: 18, scale: 6 }).notNull(),
    /** Invoiced net = qty × price (the WRX debit base / AP net), NUMERIC(18,4). */
    amount: moneyCol('amount').notNull(),
    currency: currencyCol('currency').notNull(),
    taxCode: varchar('tax_code', { length: 16 }),
  },
  (t) => [
    unique('invoice_verification_item_no_uq').on(t.invoiceVerificationId, t.lineNo),
    check('invoice_verification_item_qty_pos_ck', sql`${t.invoicedQty} > 0`),
    check('invoice_verification_item_price_nonneg_ck', sql`${t.invoiceUnitPrice} >= 0`),
    check('invoice_verification_item_amount_nonneg_ck', sql`${t.amount} >= 0`),
    foreignKey({
      name: 'invoice_verification_item_iv_fk',
      columns: [t.invoiceVerificationId],
      foreignColumns: [invoiceVerification.id],
    }),
    foreignKey({
      name: 'invoice_verification_item_po_item_fk',
      columns: [t.purchaseOrderItemId],
      foreignColumns: [purchaseOrderItem.id],
    }),
    index('invoice_verification_item_iv_idx').on(t.invoiceVerificationId),
    index('invoice_verification_item_po_item_idx').on(t.purchaseOrderItemId),
  ],
);
