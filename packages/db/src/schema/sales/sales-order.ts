import {
  char,
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
import { companyCode, plant, salesOrg, storageLocation } from '../platform/org-structure';

/**
 * Sales order (sales.sales-order = SAP SD VBAK/VBAP essence) — the MIRROR of `purchase_order` on the
 * O2C side. The selling commitment: a customer, ordered quantities at agreed SALES prices. Extends the
 * §4.2 document framework. A SO posts NOTHING to FI — value moves only at goods issue (delivery/GI →
 * COGS + stock decrement, through the goods-movement engine) and billing (Dr AR / Cr revenue + VAT).
 *
 * Progress is DERIVED, never a stored flag (D4): delivered qty = the `DELIVERS` doc_flow edges from a
 * `goods_movement` (601 GI) into a SO item; billed qty = the linked `billing_item` rows (reversal-aware).
 * There is no delivered/billed counter to drift. A SO may be FOREIGN-currency (export): billing
 * translates each invoice at its own document-date 'M' rate (single rate per billing). Lifecycle is thin
 * this slice: ORDERED → CLOSED.
 *
 * Trade hooks (§12) are ADDITIVE NULLABLE columns validated by Zod (shared enums), NOT DB CHECKs — so an
 * Incoterms revision or a new trade direction never forces a non-additive migration. `trade_direction` is
 * STORED ONLY; it never drives tax determination (the line `tax_code` does — §5).
 */

export const salesOrder = pgTable(
  'sales_order',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A SO is created already ORDERED in this slice (no quotation/approval step yet). */
    status: varchar('status', { length: 16 }).notNull().default('ORDERED'),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** The buying business partner (must carry a customer role). */
    customerBpId: uuid('customer_bp_id')
      .notNull()
      .references(() => businessPartner.id),
    /** Optional selling organization (영업조직). */
    salesOrgId: uuid('sales_org_id').references(() => salesOrg.id),
    /** Order currency — the company functional currency, or a foreign export currency (in the master). */
    currency: currencyCol('currency').notNull(),
    /** When the order was placed (business-event date). */
    orderDate: date('order_date', { mode: 'string' }).notNull(),
    /**
     * Trade hooks (§12) — additive nullable, Zod-validated (shared enums), no DB CHECK.
     *   incoterm        Incoterms 2020 term (shared `incotermSchema`)
     *   tradeDirection  EXP / DOM / IMP (shared `tradeDirectionSchema`) — STORED ONLY (never determines tax)
     *   shipToCountry   ISO-3166-1 alpha-2 ship-to country
     *   zeroRateDocNo   수출신고번호 / 내국신용장(구매확인서) 번호 backing a zero-rated (영세율) sale
     */
    incoterm: varchar('incoterm', { length: 8 }),
    tradeDirection: char('trade_direction', { length: 3 }),
    shipToCountry: char('ship_to_country', { length: 2 }),
    zeroRateDocNo: varchar('zero_rate_doc_no', { length: 35 }),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('sales_order_doc_no_uq').on(t.docNo),
    check('sales_order_status_ck', sql`${t.status} in ('ORDERED', 'CLOSED')`),
    index('sales_order_customer_idx').on(t.customerBpId),
    index('sales_order_company_idx').on(t.companyCodeId),
  ],
);

export const salesOrderItem = pgTable(
  'sales_order_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    salesOrderId: uuid('sales_order_id').notNull(),
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    /** Issuing plant; GI posts a goods movement here (valuation view must exist at this plant). */
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    /** Issuing storage location (pinned to the plant by the composite FK below); GI uses it as-is. */
    storageLocationId: uuid('storage_location_id').notNull(),
    /** Ordered quantity, NUMERIC(18,6); always positive. */
    orderedQty: quantityCol('ordered_qty').notNull(),
    /** Agreed net SALES unit price (a rate — may be finer than the currency), NUMERIC(18,6) (P-A from DTO). */
    unitPrice: numeric('unit_price', { precision: 18, scale: 6 }).notNull(),
    /** Equals the header currency (service-enforced — §11). */
    currency: currencyCol('currency').notNull(),
    /** OUTPUT VAT code billing applies to this line's net (nullable for non-taxable; §5 — explicit, never from trade_direction). */
    taxCode: varchar('tax_code', { length: 16 }),
  },
  (t) => [
    unique('sales_order_item_no_uq').on(t.salesOrderId, t.lineNo),
    check('sales_order_item_qty_pos_ck', sql`${t.orderedQty} > 0`),
    check('sales_order_item_price_nonneg_ck', sql`${t.unitPrice} >= 0`),
    // FKs declared with explicit names (mirror PO item / IV item): the auto names can exceed Postgres's
    // 63-char identifier limit (it would silently truncate, drifting from the Drizzle snapshot).
    foreignKey({
      name: 'sales_order_item_so_fk',
      columns: [t.salesOrderId],
      foreignColumns: [salesOrder.id],
    }),
    // Existence AND plant-match in one constraint (targets storage_location_id_plant_uq), like PO item.
    foreignKey({
      name: 'sales_order_item_sloc_plant_fk',
      columns: [t.storageLocationId, t.plantId],
      foreignColumns: [storageLocation.id, storageLocation.plantId],
    }),
    index('sales_order_item_so_idx').on(t.salesOrderId),
    index('sales_order_item_material_idx').on(t.materialId),
  ],
);
