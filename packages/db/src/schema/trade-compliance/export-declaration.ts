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
import { currencyCol, moneyCol, quantityCol } from '../_shared/columns';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { businessPartner } from '../master-data/business-partner';
import { material } from '../master-data/material';
import { companyCode } from '../platform/org-structure';

/**
 * Export declaration (trade-compliance.export-declaration = 수출신고 / SAP GTS customs-declaration) —
 * the first concrete document of the trade-compliance domain. The selling commitment's customs leg: a
 * filed 수출신고 with line items (material / HS / 수량 / FOB) declared to 관세청 (UNI-PASS). Extends the
 * §4.2 document framework.
 *
 * **Posts NOTHING to FI** — a Korean export is 영세율 (no output VAT, no export duty); value already moved
 * at SD billing (Dr AR / Cr revenue, the line tax_code V00 zero-rating drops the VAT line). Its lineage is
 * a doc_flow `DECLARES` edge onto the **delivery** (the 601 export goods issue / `inventory.goods_movement`)
 * — the PHYSICAL chain: 수출신고 precedes the invoice (보세반입 → 신고 → 수리 → 선적), and the delivery
 * always exists at 신고 time (출고 없이 수출 없음), so it is the safe lineage anchor (the billing may not
 * exist yet). The 영세율 / billing tax-consistency is checked by a SEPARATE read-only gate, NOT doc_flow.
 * Never a journal. (통관수수료 / 관세환급 postings are a later slice.)
 *
 * Lifecycle is thin: SUBMITTED (filed) → ACCEPTED (수리, the 수출신고번호/MRN is stamped). The MRN is an
 * EXTERNALLY-issued number (UNI-PASS), stored on its own `declaration_no` column — distinct from the
 * internal `doc_no` (ED-NNNNNN) minted by NumberingService. The UNI-PASS connector is deferred (the
 * number is captured as a manual string this slice).
 *
 * Trade hooks (§12) — incoterm / trade_direction / ship_to_country — are ADDITIVE NULLABLE columns
 * validated by Zod (shared enums), NOT DB CHECKs, so a standards revision stays additive. `hs_code` and
 * `origin_country` are SNAPSHOTTED onto each line at filing (legal immutability of the filed declaration),
 * sourced from `material_trade` when omitted; the master remains the live source. `trade_direction` is
 * STORED ONLY (it never drives tax — §5).
 */

export const exportDeclaration = pgTable(
  'export_declaration',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A declaration is created already SUBMITTED (filed); accept() flips it to ACCEPTED + stamps the MRN. */
    status: varchar('status', { length: 16 }).notNull().default('SUBMITTED'),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** The foreign buyer / consignee (must carry a customer role). */
    customerBpId: uuid('customer_bp_id')
      .notNull()
      .references(() => businessPartner.id),
    /** The customs broker (관세사) that filed the declaration, when used. */
    brokerBpId: uuid('broker_bp_id').references(() => businessPartner.id),
    /**
     * 수출신고번호 (UNI-PASS MRN) — EXTERNALLY issued on 수리(acceptance). NULL until accepted; captured as
     * a manual string this slice (the UNI-PASS connector is deferred). Distinct from the internal doc_no.
     */
    declarationNo: varchar('declaration_no', { length: 35 }),
    /** Declaration (filing) date — the business-event date. */
    declarationDate: date('declaration_date', { mode: 'string' }).notNull(),
    /**
     * Trade hooks (§12) — additive nullable, Zod-validated (shared enums), no DB CHECK.
     *   incoterm        Incoterms 2020 term (shared `incotermSchema`)
     *   tradeDirection  EXP / DOM / IMP (shared `tradeDirectionSchema`) — STORED ONLY (never determines tax)
     *   shipToCountry   ISO-3166-1 alpha-2 destination country
     */
    incoterm: varchar('incoterm', { length: 8 }),
    tradeDirection: char('trade_direction', { length: 3 }),
    shipToCountry: char('ship_to_country', { length: 2 }),
    /** 세관 (customs office) code. */
    customsOffice: varchar('customs_office', { length: 16 }),
    /** Declaration value currency — the export invoice currency (may be foreign). */
    currency: currencyCol('currency').notNull(),
    /**
     * Applied declaration-date 'M' rate to the functional currency (KRW) for a FOREIGN declaration — an
     * audit/reporting stamp only (the declaration posts NOTHING). NULL for a domestic functional-currency
     * declaration (rate is the 1.0 identity, never stored).
     */
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 6 }),
    /** Σ line FOB (declaration currency), NUMERIC(18,4) — derived from the lines, service-computed. */
    totalFobAmount: moneyCol('total_fob_amount').notNull(),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('export_declaration_doc_no_uq').on(t.docNo),
    check('export_declaration_status_ck', sql`${t.status} in ('SUBMITTED', 'ACCEPTED')`),
    check('export_declaration_total_fob_nonneg_ck', sql`${t.totalFobAmount} >= 0`),
    index('export_declaration_company_idx').on(t.companyCodeId),
    index('export_declaration_customer_idx').on(t.customerBpId),
    index('export_declaration_decl_no_idx').on(t.declarationNo),
  ],
);

export const exportDeclarationItem = pgTable(
  'export_declaration_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    declarationId: uuid('declaration_id').notNull(),
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    /**
     * HS classification snapshot (관세 품목분류) — snapshotted at filing for the legal immutability of the
     * declaration; sourced from `material_trade.hs_code` when the DTO omits it. Additive nullable (no DB
     * CHECK — the trade-hook convention), so a re-classification of the master never rewrites filed lines.
     */
    hsCode: varchar('hs_code', { length: 16 }),
    /** Country of origin snapshot (원산지), ISO-3166-1 alpha-2; sourced from `material_trade` when omitted. */
    originCountry: char('origin_country', { length: 2 }),
    /** Declared export quantity, NUMERIC(18,6); always positive. */
    qty: quantityCol('qty').notNull(),
    /** Unit of measure (e.g. EA / KG). */
    uom: varchar('uom', { length: 8 }).notNull(),
    /** Line FOB amount (declaration currency), NUMERIC(18,4). */
    fobAmount: moneyCol('fob_amount').notNull(),
    /** Equals the header currency (service-enforced — §11). */
    currency: currencyCol('currency').notNull(),
    /** Net weight (순중량), NUMERIC(18,6) — optional. */
    netWeight: quantityCol('net_weight'),
  },
  (t) => [
    unique('export_declaration_item_no_uq').on(t.declarationId, t.lineNo),
    check('export_declaration_item_qty_pos_ck', sql`${t.qty} > 0`),
    check('export_declaration_item_fob_nonneg_ck', sql`${t.fobAmount} >= 0`),
    check(
      'export_declaration_item_weight_nonneg_ck',
      sql`${t.netWeight} is null or ${t.netWeight} >= 0`,
    ),
    // Item→header FK with an explicit name (auto names can exceed Postgres's 63-char limit and silently
    // truncate, drifting the Drizzle snapshot) — same as sales_order_item / billing_item.
    foreignKey({
      name: 'export_declaration_item_decl_fk',
      columns: [t.declarationId],
      foreignColumns: [exportDeclaration.id],
    }),
    index('export_declaration_item_decl_idx').on(t.declarationId),
    index('export_declaration_item_material_idx').on(t.materialId),
  ],
);
