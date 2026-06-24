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
import { auditColumns, currencyCol, moneyCol, pk } from '../_shared/columns';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { companyCode } from '../platform/org-structure';

/**
 * Duty drawback (trade-compliance.duty-drawback = 관세환급 / SAP GTS) — 간이정액환급 (simplified fixed-rate)
 * v1. The FIRST POSTING document of the trade-compliance domain: a refund claim bundles one or more 수출신고
 * (export_declaration) lines, computes the refundable customs duty from the 간이정액환급률표 (FOB 1만원당
 * 환급액 × FOB / 10000), and on 관세청 결정(approve) posts the FIRST real FI journal in trade-compliance —
 * Dr 관세환급금 미수금 / Cr 관세환급수익 (account-determination, never hard-coded). Extends the §4.2 document
 * framework. (개별환급 — BOM/소요량 전개 — and 환급금 입금 클리어링 are later slices.)
 *
 * Lifecycle: CLAIMED (filed, **non-posting**) → APPROVED (관세청 결정, the FI journal posts; idempotent on
 * the claim — a replay returns the live state, never double-posts). The refund is KRW (KRW=functional), so
 * the journal is single-currency, two-line, no FX.
 */

/**
 * 간이정액환급률 마스터 (simplified fixed-rate table) — `rate_per_10k` = the refund (원) per 10,000원 of FOB
 * for an HS code, effective over [valid_from, valid_to] (valid_to NULL = open-ended into the future). A
 * config/master table (NOT a document), so audit-4 only. The claim matches a line's snapshot HS code on the
 * source 수출신고 수리일.
 */
export const drawbackSimplifiedRate = pgTable(
  'drawback_simplified_rate',
  {
    id: pk(),
    /** HS classification (관세 품목분류) — digits only 6–10, matching material_trade.hs_code. */
    hsCode: varchar('hs_code', { length: 16 }).notNull(),
    /** 환급액(원) per 10,000원 FOB — the 간이정액환급률표 value, NUMERIC(18,4) (KRW; no currency pair). */
    ratePer10k: numeric('rate_per_10k', { precision: 18, scale: 4 }).notNull(),
    /** Effective-from (inclusive). */
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    /** Effective-to (inclusive); NULL = open-ended. */
    validTo: date('valid_to', { mode: 'string' }),
    ...auditColumns(),
  },
  (t) => [
    // One 간이정액률 per (HS, effective-from) — two rows sharing a valid_from would make the most-recent
    // resolution (ORDER BY valid_from DESC LIMIT 1) ambiguous. Also the seed's idempotency target.
    unique('drawback_simplified_rate_hs_from_uq').on(t.hsCode, t.validFrom),
    check('drawback_simplified_rate_per10k_nonneg_ck', sql`${t.ratePer10k} >= 0`),
    check('drawback_simplified_rate_hs_code_ck', sql`${t.hsCode} ~ '^[0-9]{6,10}$'`),
    check(
      'drawback_simplified_rate_validity_ck',
      sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`,
    ),
    index('drawback_simplified_rate_lookup_idx').on(t.hsCode, t.validFrom),
  ],
);

export const drawbackClaim = pgTable(
  'drawback_claim',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key (set on approve), audit-4.
    ...documentHeaderColumns(),
    /** A claim is created already CLAIMED (filed, non-posting); approve() flips it to APPROVED + posts. */
    status: varchar('status', { length: 16 }).notNull().default('CLAIMED'),
    /**
     * The posting org — drives the FI journal's company code + account-determination chart + the 'KRW'
     * functional currency. A claim's source 수출신고 must all belong to this company (service-enforced).
     */
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** 환급신청일 (claim filing date). */
    claimDate: date('claim_date', { mode: 'string' }).notNull(),
    /** 환급결정일 (관세청 결정) — stamped on approve(); NULL until approved. */
    approvalDate: date('approval_date', { mode: 'string' }),
    /** Σ line 환급액 신청분 (KRW), NUMERIC(18,4) — service-computed from the lines. */
    claimedTotalAmount: moneyCol('claimed_total_amount').notNull(),
    claimedTotalCurrency: currencyCol('claimed_total_currency').notNull().default('KRW'),
    /** 관세청 결정 환급액 (KRW) — set on approve (defaults to claimed); may differ (결정액 우선). NULL until then. */
    approvedTotalAmount: moneyCol('approved_total_amount'),
    approvedTotalCurrency: currencyCol('approved_total_currency'),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('drawback_claim_doc_no_uq').on(t.docNo),
    check('drawback_claim_status_ck', sql`${t.status} in ('CLAIMED', 'APPROVED')`),
    check('drawback_claim_claimed_total_nonneg_ck', sql`${t.claimedTotalAmount} >= 0`),
    check(
      'drawback_claim_approved_total_nonneg_ck',
      sql`${t.approvedTotalAmount} is null or ${t.approvedTotalAmount} >= 0`,
    ),
    index('drawback_claim_company_idx').on(t.companyCodeId),
    index('drawback_claim_status_idx').on(t.status),
  ],
);

export const drawbackClaimItem = pgTable(
  'drawback_claim_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    claimId: uuid('claim_id').notNull(),
    /**
     * The source 수출신고 (export_declaration.id) this refund line draws from — a PLAIN uuid (no cross-domain
     * FK; the doc_flow REFUNDS edge carries lineage, the graph is generic — same convention as 수입신고's
     * source_goods_movement_id). The service resolves it READ-ONLY (must be this company's; status drives G0).
     */
    sourceExportDeclarationId: uuid('source_export_declaration_id').notNull(),
    /** The source 수출신고 line (export_declaration_item.id) — a PLAIN uuid; validated to belong to the header. */
    sourceExportDeclarationItemRef: uuid('source_export_declaration_item_ref').notNull(),
    /**
     * 수출신고 수리일 SNAPSHOT — the basis date the fx_rate + applied_rate were resolved on, and the 환급기한
     * (수리일 + 2년) reference. Snapshotted at claim time so the line stays self-contained: if the source
     * export's acceptance_date later changes, the refund calc is still exactly reproducible/auditable from
     * the line alone (snapshot immutability, §5.1 spirit).
     */
    sourceAcceptanceDate: date('source_acceptance_date', { mode: 'string' }).notNull(),
    /** HS classification SNAPSHOT (관세 품목분류) — immutable; the 간이정액률 lookup key. */
    hsCode: varchar('hs_code', { length: 16 }).notNull(),
    /** Source line FOB (export declaration currency), NUMERIC(18,4) — snapshot. */
    fobAmount: moneyCol('fob_amount').notNull(),
    fobCurrency: currencyCol('fob_currency').notNull(),
    /** FOB translated to KRW (always populated): auto = convert@수리일 'M' rate, or the manual 원화 FOB override. */
    fobKrwAmount: moneyCol('fob_krw_amount').notNull(),
    /**
     * 수리일 'M' rate snapshot when fob_krw was AUTO-converted, NUMERIC(18,6) (matches the fx_rate master
     * scale for exact reproduction — NOT the 18,4 of money). NULL when fob_krw was a manual 원화 FOB override.
     */
    fxRate: numeric('fx_rate', { precision: 18, scale: 6 }),
    /** Applied 간이정액환급률 SNAPSHOT (원/10,000원 FOB), NUMERIC(18,4); 0 when no rate matched (개별환급 대상/률표 누락). */
    appliedRate: numeric('applied_rate', { precision: 18, scale: 4 }).notNull(),
    /** Line 환급액 (KRW), NUMERIC(18,4) = round(fob_krw / 10000 × applied_rate). */
    lineRefundAmount: moneyCol('line_refund_amount').notNull(),
  },
  (t) => [
    unique('drawback_claim_item_no_uq').on(t.claimId, t.lineNo),
    check('drawback_claim_item_fob_nonneg_ck', sql`${t.fobAmount} >= 0`),
    check('drawback_claim_item_fob_krw_nonneg_ck', sql`${t.fobKrwAmount} >= 0`),
    check('drawback_claim_item_applied_rate_nonneg_ck', sql`${t.appliedRate} >= 0`),
    check('drawback_claim_item_refund_nonneg_ck', sql`${t.lineRefundAmount} >= 0`),
    // Item→header FK with an explicit name (auto names can exceed Postgres's 63-char limit and silently
    // truncate, drifting the Drizzle snapshot) — same as export/import_declaration_item.
    foreignKey({
      name: 'drawback_claim_item_claim_fk',
      columns: [t.claimId],
      foreignColumns: [drawbackClaim.id],
    }),
    index('drawback_claim_item_claim_idx').on(t.claimId),
    index('drawback_claim_item_source_decl_idx').on(t.sourceExportDeclarationId),
  ],
);
