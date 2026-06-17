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
import { currencyCol, moneyCol } from '../_shared/columns';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { businessPartner } from '../master-data/business-partner';
import { material } from '../master-data/material';
import { companyCode, plant } from '../platform/org-structure';
import { purchaseOrder, purchaseOrderItem } from './purchase-order';

/**
 * Landed cost (procurement.landed-cost = SAP MM subsequent-debit / Nachbelastung essence). The
 * actual-cost document that capitalizes import incidental costs (관세·해상/항공 운임·적하보험·통관수수료)
 * into the received stock's inventory value, and books the customs-paid import VAT (수입부가세) as a
 * deductible input-VAT receivable. It is a SUBSEQUENT, actual-cost event: there is no planned accrual
 * at GR, so there is NO intermediate per-cost-type clearing — ONE document posts ONE journal that
 * capitalizes straight to BSX and raises the forwarder/관세사 AP open item.
 *
 * FI posting (one `KR` journal, like IV): **Dr BSX** the covered cost share (a value-only revaluation
 * of `material_valuation` — qty unchanged, MAP re-derived) + **Dr 부가세대급금** the import VAT (1350,
 * NOT capitalized — input VAT, 매입세액공제) + **Dr 재고원가차이 (PRD)** the uncovered share for stock
 * already issued before the cost arrived + **Cr AP recon (+forwarder/관세사 partner)** the gross. A
 * FOREIGN cost invoice translates the AP at the document-date 'M' rate and routes the per-line
 * translation residue to realized FX (9810/9820), the document currency being the cost-invoice
 * currency (`exchange_rate` stamps the applied rate). The capitalized BSX share is the only thing that
 * touches `stock_value`, so Σ stock_value == BSX still holds (recon delta 0). Posted-only + idempotent
 * on `posting_key`; reversal-protected via the POSTS doc_flow edge (correction = a future cancel).
 */

export const landedCost = pgTable(
  'landed_cost',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A landed-cost doc exists only once posted (no DRAFT; cancel/reversal is a follow-up slice). */
    status: varchar('status', { length: 16 }).notNull().default('POSTED'),
    /** Idempotency key (§5.2) — NOT NULL here; the UNIQUE below is the exactly-once gate. */
    postingKey: varchar('posting_key', { length: 128 }).notNull(),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** The forwarder / 관세사 the AP open item is raised against (must carry a vendor role). */
    vendorBpId: uuid('vendor_bp_id')
      .notNull()
      .references(() => businessPartner.id),
    /** The import PO whose received stock this cost capitalizes onto (one PO per doc in this slice). */
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id),
    /** Forwarder/관세사 invoice / 세금계산서 number. */
    reference: varchar('reference', { length: 128 }).notNull(),
    /**
     * 수입신고번호 — the customs declaration the import VAT belongs to. The 수입세금계산서's VAT
     * counterparty is 세관 (not the 관세사 we pay), so this is captured for the future 부가세신고
     * 매입처별세금계산서합계표; it changes no posting.
     */
    importDeclarationNo: varchar('import_declaration_no', { length: 64 }),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    /** Cost-invoice (document) currency — the company functional currency, or a foreign one. */
    currency: currencyCol('currency').notNull(),
    /**
     * Applied document→functional 'M' rate for a FOREIGN cost invoice (resolved on the document
     * date) — the audit record of the rate the AP leg and realized-FX residue used. NULL for a
     * domestic functional-currency cost invoice (rate is the 1.0 identity, never stored).
     */
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 6 }),
    /** Total incidental cost being allocated/capitalized, in the DOCUMENT currency (gross of VAT). */
    costAmount: moneyCol('cost_amount').notNull(),
    /**
     * Customs-paid import VAT (수입부가세) in the FUNCTIONAL currency (KRW) — the 수입세금계산서 amount
     * computed by customs on 과세표준 (CIF + 관세), supplied DIRECTLY (never derived from a net × rate).
     * Posted Dr 부가세대급금 1350; NEVER capitalized into stock_value. Only non-zero on a
     * functional-currency document (service-enforced: a foreign forwarder freight invoice carries no
     * customs VAT — that rides the separate KRW 관세사 settlement).
     */
    importVatAmount: moneyCol('import_vat_amount').notNull().default('0'),
    /** The INPUT import-VAT tax code (→ 1350) carried for 매입세액공제 reporting; NULL when VAT is 0. */
    vatTaxCode: varchar('vat_tax_code', { length: 16 }),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('landed_cost_posting_key_uq').on(t.companyCodeId, t.postingKey),
    unique('landed_cost_doc_no_uq').on(t.docNo),
    check('landed_cost_status_ck', sql`${t.status} = 'POSTED'`),
    check('landed_cost_cost_amount_nonneg_ck', sql`${t.costAmount} >= 0`),
    check('landed_cost_import_vat_nonneg_ck', sql`${t.importVatAmount} >= 0`),
    index('landed_cost_po_idx').on(t.purchaseOrderId),
    index('landed_cost_vendor_idx').on(t.vendorBpId),
  ],
);

export const landedCostItem = pgTable(
  'landed_cost_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    // FKs declared below with explicit names: the auto-generated item→po_item name exceeds Postgres's
    // 63-char identifier limit (it would silently truncate, drifting from the Drizzle snapshot).
    landedCostId: uuid('landed_cost_id').notNull(),
    /** The import PO item this line allocates onto (its received functional value is the basis). */
    purchaseOrderItemId: uuid('purchase_order_item_id').notNull(),
    /** Capitalization target (material, plant) — the value-only revaluation locks this valuation row. */
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    /** Allocation basis: the GR-booked functional (KRW) value of this PO item's received stock. */
    receivedFunctionalValue: moneyCol('received_functional_value').notNull(),
    /** Cost allocated to this line (largest-remainder by basis), functional (KRW) = covered + prd. */
    capitalizedShare: moneyCol('capitalized_share').notNull(),
    /** Portion actually added to material_valuation.stock_value (stock still on hand), functional. */
    coveredShare: moneyCol('covered_share').notNull(),
    /** Uncovered portion (stock already issued) booked to 재고원가차이 (PRD), functional; 0 when fully covered. */
    prdAmount: moneyCol('prd_amount').notNull().default('0'),
    /** Functional currency (KRW) — the capitalized amounts are always functional (Option-P). */
    currency: currencyCol('currency').notNull(),
  },
  (t) => [
    unique('landed_cost_item_no_uq').on(t.landedCostId, t.lineNo),
    check('landed_cost_item_basis_nonneg_ck', sql`${t.receivedFunctionalValue} >= 0`),
    check('landed_cost_item_share_nonneg_ck', sql`${t.capitalizedShare} >= 0`),
    check('landed_cost_item_covered_nonneg_ck', sql`${t.coveredShare} >= 0`),
    check('landed_cost_item_prd_nonneg_ck', sql`${t.prdAmount} >= 0`),
    // The covered/uncovered split conserves the allocated share exactly (no lost minor unit).
    check(
      'landed_cost_item_split_ck',
      sql`${t.capitalizedShare} = ${t.coveredShare} + ${t.prdAmount}`,
    ),
    foreignKey({
      name: 'landed_cost_item_lc_fk',
      columns: [t.landedCostId],
      foreignColumns: [landedCost.id],
    }),
    foreignKey({
      name: 'landed_cost_item_po_item_fk',
      columns: [t.purchaseOrderItemId],
      foreignColumns: [purchaseOrderItem.id],
    }),
    index('landed_cost_item_lc_idx').on(t.landedCostId),
    index('landed_cost_item_po_item_idx').on(t.purchaseOrderItemId),
    index('landed_cost_item_material_idx').on(t.materialId),
  ],
);
