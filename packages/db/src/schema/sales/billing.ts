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
import { journalEntry } from '../finance-accounting/journal';
import { companyCode } from '../platform/org-structure';
import { salesOrder, salesOrderItem } from './sales-order';

/**
 * Billing (sales.billing = SAP SD VBRK/VBRP / FB70 essence) — the MIRROR of `invoice_verification` on
 * the O2C side. It bills DELIVERED quantities of a SO and raises the AR open item, posting — in ONE
 * transaction (§5.2) — the billing matching record and a `DR` customer-invoice journal:
 *
 *   Dr AR reconciliation (gross, + customer partner)   ← recon substitution from the customer role
 *   Cr revenue account(s) from the DTO (net, per line)  ← account from the document, not VKOA
 *   Cr output VAT account(s) (Σ per-line tax, per code)  ← shared tax-line builder; zero-rated (V00) drops
 *
 * It REUSES the AR single-rate journal path (`ar-invoice.service`) — recon substitution, the tax-line
 * builder, the open-item model — but posts through `JournalService.post(..., { tx })` directly so the
 * billing record + journal + lineage commit atomically. Unlike IV it writes **no POSTS edge** onto its
 * journal (it stores the link as the `journal_entry_id` FK instead), so `JournalService.reverse()` can
 * still correct it; `billedBySoItem` excludes REVERSED journals. A FOREIGN (export) billing translates
 * every line at the billing document-date 'M' rate (a single rate per billing; `exchange_rate` is the
 * audit stamp). Realized FX is 0 at billing — it arises only at customer-payment clearing (DZ).
 * Posted-only + idempotent on `posting_key`.
 */

export const billing = pgTable(
  'billing',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A billing exists only once posted (no DRAFT; cancel/reversal is a follow-up slice). */
    status: varchar('status', { length: 16 }).notNull().default('POSTED'),
    /** Idempotency key (§5.2) — NOT NULL here; the UNIQUE below is the exactly-once gate. */
    postingKey: varchar('posting_key', { length: 128 }).notNull(),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    customerBpId: uuid('customer_bp_id')
      .notNull()
      .references(() => businessPartner.id),
    /** The SO this billing invoices (one SO per billing in this slice). */
    salesOrderId: uuid('sales_order_id').notNull(),
    /**
     * The `DR` AR journal this billing posted. NULLABLE only intra-transaction (set immediately after the
     * journal posts, in the same tx — never null post-commit). Stored as an FK, NOT a POSTS doc_flow edge,
     * precisely so `JournalService.reverse()` stays allowed (the reverse-fence checks for incoming POSTS).
     */
    journalEntryId: uuid('journal_entry_id'),
    /** Customer invoice / 세금계산서 number. */
    reference: varchar('reference', { length: 128 }).notNull(),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    currency: currencyCol('currency').notNull(),
    /**
     * Applied document→functional 'M' rate for a FOREIGN (export) billing (resolved on the document date)
     * — the audit record of the rate the AR/revenue/VAT lines were translated at. NULL for a domestic
     * functional-currency billing (rate is the 1.0 identity, never stored).
     */
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 6 }),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('billing_posting_key_uq').on(t.companyCodeId, t.postingKey),
    unique('billing_doc_no_uq').on(t.docNo),
    check('billing_status_ck', sql`${t.status} = 'POSTED'`),
    foreignKey({
      name: 'billing_so_fk',
      columns: [t.salesOrderId],
      foreignColumns: [salesOrder.id],
    }),
    foreignKey({
      name: 'billing_journal_fk',
      columns: [t.journalEntryId],
      foreignColumns: [journalEntry.id],
    }),
    index('billing_so_idx').on(t.salesOrderId),
    index('billing_customer_idx').on(t.customerBpId),
  ],
);

export const billingItem = pgTable(
  'billing_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    billingId: uuid('billing_id').notNull(),
    /** The SO item this line bills (the BILLS edge carries the same lineage for §4.3 drill-down). */
    salesOrderItemId: uuid('sales_order_item_id').notNull(),
    /** Billed quantity, NUMERIC(18,6); positive. */
    billedQty: quantityCol('billed_qty').notNull(),
    /** SALES unit price snapshot (the SO line price), NUMERIC(18,6). */
    unitPrice: numeric('unit_price', { precision: 18, scale: 6 }).notNull(),
    /** Billed net = qty × price (the revenue credit base / AR net), NUMERIC(18,4), document currency. */
    amount: moneyCol('amount').notNull(),
    /** Revenue GL account this line credits (D: from the document, not VKOA). */
    revenueAccount: varchar('revenue_account', { length: 16 }).notNull(),
    currency: currencyCol('currency').notNull(),
    taxCode: varchar('tax_code', { length: 16 }),
  },
  (t) => [
    unique('billing_item_no_uq').on(t.billingId, t.lineNo),
    check('billing_item_qty_pos_ck', sql`${t.billedQty} > 0`),
    check('billing_item_price_nonneg_ck', sql`${t.unitPrice} >= 0`),
    check('billing_item_amount_nonneg_ck', sql`${t.amount} >= 0`),
    foreignKey({
      name: 'billing_item_billing_fk',
      columns: [t.billingId],
      foreignColumns: [billing.id],
    }),
    foreignKey({
      name: 'billing_item_so_item_fk',
      columns: [t.salesOrderItemId],
      foreignColumns: [salesOrderItem.id],
    }),
    index('billing_item_billing_idx').on(t.billingId),
    index('billing_item_so_item_idx').on(t.salesOrderItemId),
  ],
);
