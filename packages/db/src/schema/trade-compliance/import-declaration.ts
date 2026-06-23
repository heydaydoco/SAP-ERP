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
 * Import declaration (trade-compliance.import-declaration = 수입신고 / SAP GTS customs-declaration) — the
 * symmetric IMPORT leg of the customs-declaration module. A filed 수입신고 against a received import GR,
 * with line items (material / HS / 원산지 / 수량 / 과세가격 / 관세율) declared to 관세청 (UNI-PASS). Extends
 * the §4.2 document framework. Mirrors `export_declaration`.
 *
 * **Posts NOTHING to FI.** Import accounting — 관세 + 수입부가세 capitalized into inventory cost (Dr BSX /
 * Dr PRD / Dr 부가세대급금 1350 / Cr AP / realized-FX) — is the **landed-cost** document's SOLE job, already
 * booked at/after the GR. A 수입신고 that posted again would double-count, so `customs_value` / `duty_amount`
 * / `import_vat_amount` here are **legal declaration RECORD fields**, never journals. Its only linkage is a
 * doc_flow `DECLARES` edge onto the SAME 수입 GR (101 goods_movement / `inventory.goods_movement`) that
 * landed cost capitalizes against — the symmetry of export's `DECLARES`→601 GI. landed cost is read-only to
 * this slice and untouched.
 *
 * Lifecycle is thin: SUBMITTED (filed) → ACCEPTED (수리, stamping the externally-issued 수입신고번호/MRN +
 * 신고수리일). The MRN is an EXTERNALLY-issued number (UNI-PASS), on its own `declaration_no` column, distinct
 * from the internal `doc_no` (IM-NNNNNN minted by NumberingService). The UNI-PASS connector is deferred
 * (the number is a manual string this slice).
 *
 * Trade hooks (§12) — incoterm / trade_direction / origin_country / customs_office — are ADDITIVE NULLABLE
 * columns validated by Zod (shared enums), NOT DB CHECKs. `hs_code` and `origin_country` are SNAPSHOTTED onto
 * each line at filing (legal immutability), sourced from `material_trade` when omitted. `trade_direction` is
 * STORED ONLY (defaults IMP; never drives anything — a 수입신고 is an explicit declaration, never inferred).
 */

export const importDeclaration = pgTable(
  'import_declaration',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A declaration is created already SUBMITTED (filed); accept() flips it to ACCEPTED + stamps the MRN. */
    status: varchar('status', { length: 16 }).notNull().default('SUBMITTED'),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** The overseas supplier / consignor (must carry a vendor role). */
    supplierBpId: uuid('supplier_bp_id')
      .notNull()
      .references(() => businessPartner.id),
    /** The customs broker (관세사) that filed the declaration, when used. */
    brokerBpId: uuid('broker_bp_id').references(() => businessPartner.id),
    /**
     * The import goods receipt (수입 GR — a 101 `goods_movement`) this declaration is filed against: the
     * PHYSICAL lineage anchor, symmetric to export's 601 GI. A PLAIN uuid — NOT a cross-domain FK (the
     * doc_flow `DECLARES` edge carries lineage, the graph is generic, like export's GI reference). The
     * service resolves it READ-ONLY (must be a 101 GR of this company); landed cost shares this same node.
     */
    sourceGoodsMovementId: uuid('source_goods_movement_id').notNull(),
    /**
     * 수입신고번호 (UNI-PASS MRN) — EXTERNALLY issued on 수리(acceptance). NULL until accepted; captured as a
     * manual string this slice (the UNI-PASS connector is deferred). Distinct from the internal doc_no.
     */
    declarationNo: varchar('declaration_no', { length: 35 }),
    /** 신고일 (filing date) — the business-event date; the FX 'M' rate is resolved on it. */
    declarationDate: date('declaration_date', { mode: 'string' }).notNull(),
    /** 신고수리일 — stamped on accept() (수리); NULL until accepted. */
    acceptanceDate: date('acceptance_date', { mode: 'string' }),
    /**
     * Trade hooks (§12) — additive nullable, Zod-validated (shared enums), no DB CHECK.
     *   incoterm        Incoterms 2020 term (shared `incotermSchema`)
     *   tradeDirection  EXP / DOM / IMP (shared `tradeDirectionSchema`) — STORED ONLY (never determines tax)
     *   originCountry   ISO-3166-1 alpha-2 predominant 원산지 (header-level hook; per-line origin is snapshotted)
     */
    incoterm: varchar('incoterm', { length: 8 }),
    tradeDirection: char('trade_direction', { length: 3 }),
    originCountry: char('origin_country', { length: 2 }),
    /** 세관 (customs office) code. */
    customsOffice: varchar('customs_office', { length: 16 }),
    /** Declaration value currency — the import invoice currency (may be foreign). */
    currency: currencyCol('currency').notNull(),
    /**
     * Applied declaration-date 'M' rate to the functional currency (KRW) for a FOREIGN declaration — an
     * audit/reporting stamp only (the declaration posts NOTHING). NULL for a domestic functional-currency
     * declaration (rate is the 1.0 identity, never stored).
     */
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 6 }),
    /**
     * 과세가격 (CIF customs value) — a LEGAL DECLARATION RECORD field, posts NOTHING. The declared header
     * total; the line sum is consistency-checked against it (G3a). Import accounting (관세 + 수입부가세
     * capitalization) belongs to the landed-cost document alone.
     */
    customsValue: moneyCol('customs_value').notNull(),
    /** 관세액 (customs duty) — declaration RECORD field, posts NOTHING (landed cost owns the accounting). */
    dutyAmount: moneyCol('duty_amount').notNull(),
    /** 수입부가세액 (import VAT) — declaration RECORD field, posts NOTHING (landed cost books 부가세대급금). */
    importVatAmount: moneyCol('import_vat_amount').notNull(),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('import_declaration_doc_no_uq').on(t.docNo),
    check('import_declaration_status_ck', sql`${t.status} in ('SUBMITTED', 'ACCEPTED')`),
    check('import_declaration_customs_value_nonneg_ck', sql`${t.customsValue} >= 0`),
    check('import_declaration_duty_nonneg_ck', sql`${t.dutyAmount} >= 0`),
    check('import_declaration_vat_nonneg_ck', sql`${t.importVatAmount} >= 0`),
    index('import_declaration_company_idx').on(t.companyCodeId),
    index('import_declaration_supplier_idx').on(t.supplierBpId),
    index('import_declaration_gr_idx').on(t.sourceGoodsMovementId),
    index('import_declaration_decl_no_idx').on(t.declarationNo),
  ],
);

export const importDeclarationItem = pgTable(
  'import_declaration_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    declarationId: uuid('declaration_id').notNull(),
    /**
     * Source GR line (`goods_movement_item.id`) this declared line maps to — a PLAIN uuid (no cross-domain
     * FK; the doc_flow graph is generic). Nullable: a declared line need not map 1:1 to a GR line (e.g.
     * consolidated 통관). When present, the service validates it belongs to the header's source GR.
     */
    sourceGrItemRef: uuid('source_gr_item_ref'),
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    /**
     * HS classification snapshot (관세 품목분류) — snapshotted at filing for legal immutability; sourced from
     * `material_trade.hs_code` when the DTO omits it. Additive nullable (no DB CHECK — the trade-hook
     * convention), so a master re-classification never rewrites filed lines.
     */
    hsCode: varchar('hs_code', { length: 16 }),
    /** Country of origin snapshot (원산지), ISO-3166-1 alpha-2; from `material_trade` when omitted. */
    originCountry: char('origin_country', { length: 2 }),
    /** Declared import quantity, NUMERIC(18,6); always positive. */
    qty: quantityCol('qty').notNull(),
    /** Unit of measure (e.g. EA / KG). */
    uom: varchar('uom', { length: 8 }).notNull(),
    /** Line 과세가격 (CIF customs value), NUMERIC(18,4) — declaration RECORD field, posts nothing. */
    customsValue: moneyCol('customs_value').notNull(),
    /** 관세율 (%) — the G3b duty-sanity input; NUMERIC(7,4), NULL when not declared per line. */
    dutyRate: numeric('duty_rate', { precision: 7, scale: 4 }),
    /** Equals the header currency (service-enforced). */
    currency: currencyCol('currency').notNull(),
  },
  (t) => [
    unique('import_declaration_item_no_uq').on(t.declarationId, t.lineNo),
    check('import_declaration_item_qty_pos_ck', sql`${t.qty} > 0`),
    check('import_declaration_item_customs_value_nonneg_ck', sql`${t.customsValue} >= 0`),
    check(
      'import_declaration_item_duty_rate_nonneg_ck',
      sql`${t.dutyRate} is null or ${t.dutyRate} >= 0`,
    ),
    // Item→header FK with an explicit name (auto names can exceed Postgres's 63-char limit and silently
    // truncate, drifting the Drizzle snapshot) — same as export_declaration_item / billing_item.
    foreignKey({
      name: 'import_declaration_item_decl_fk',
      columns: [t.declarationId],
      foreignColumns: [importDeclaration.id],
    }),
    index('import_declaration_item_decl_idx').on(t.declarationId),
    index('import_declaration_item_material_idx').on(t.materialId),
  ],
);
