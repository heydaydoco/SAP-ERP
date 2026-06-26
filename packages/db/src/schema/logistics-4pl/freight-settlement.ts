import {
  check,
  date,
  index,
  numeric,
  pgTable,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { currencyCol, moneyCol } from '../_shared/columns';
import { documentHeaderColumns } from '../_shared/document';
import { businessPartner } from '../master-data/business-partner';
import { companyCode } from '../platform/org-structure';

/**
 * Freight settlement (logistics-4pl.freight-settlement = 포워더 운임 송장, SAP FB60-essence) — the FIRST FI
 * document of the 4PL logistics domain. The shipment (선적) shipped in the previous slice is a NON-POSTING
 * physical backbone; this is the first cost that hangs off it and raises an AP open item. Like landed-cost it
 * is the "the journal IS the AP document" model — there is no separate ap_invoice store: the service calls
 * `JournalService.post(docType='KR')` directly and the KR journal IS the payable that clearing later settles.
 *
 * FI posting (ONE `KR` journal, exactly two lines — no VAT in v1: a foreign forwarder's export freight is a
 * 국외제공용역/영세율 supply, so there is no deductible import VAT):
 *   **Dr 지급운임** the freight expense (resolved via account_determination `FREIGHT`, never hard-coded §4.5)
 *   **Cr AP recon (+forwarder partner)** the gross payable (substituted from the forwarder's vendor role)
 * A FOREIGN-currency freight invoice translates at the document-date 'M' rate (or an explicit `fxRate`
 * override) — the freight service NEVER does FX math itself: it hands the rate to `JournalService.post`, which
 * stamps the header rate, translates each line, and (because the recon leg carries its functional amount) ties
 * out in both currencies with no FX_ROUNDING residue. `exchange_rate` stamps the applied rate (NULL domestic).
 *
 * Header-only (no item table): the forwarder invoice's ocean freight + THC + 내륙 charges arrive as ONE summed
 * amount in v1 (detail rides `reference`/`header_text`); per-charge cost-account split is a later slice.
 * `shipment_id` is a PLAIN uuid (no cross-domain FK — the doc_flow graph is generic, same convention as
 * shipment_item.delivery_id); the service resolves it READ-ONLY (must exist + same company). Lineage is two
 * doc_flow edges: SETTLES → shipment (which 선적 this freight is for) and POSTS → its journal (the FI
 * reverse-guard literal → this KR journal is subledger-owned, FI reverse refused; correction is a future
 * cancel). Posted-only + idempotent on `posting_key`.
 */

export const freightSettlement = pgTable(
  'freight_settlement',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A freight settlement exists only once posted (no DRAFT; cancel/reversal is a follow-up slice). */
    status: varchar('status', { length: 16 }).notNull().default('POSTED'),
    /** Idempotency key (§5.2) — NOT NULL here; the UNIQUE below is the exactly-once gate. */
    postingKey: varchar('posting_key', { length: 128 }).notNull(),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /**
     * The shipment (선적) this freight settles — a PLAIN uuid (no cross-domain FK; the doc_flow `SETTLES`
     * edge carries lineage, the graph is generic — same convention as shipment_item.delivery_id). The
     * service resolves it READ-ONLY (must exist and belong to this company).
     */
    shipmentId: uuid('shipment_id').notNull(),
    /** The forwarder (포워더) the AP open item is raised against (must carry a vendor role; recon substituted from it). */
    forwarderBpId: uuid('forwarder_bp_id')
      .notNull()
      .references(() => businessPartner.id),
    /** Freight-invoice (document) currency — the company functional currency, or a foreign one. */
    currency: currencyCol('currency').notNull(),
    /**
     * Applied document→functional 'M' rate for a FOREIGN freight invoice (resolved on the document date,
     * or an explicit override) — the audit record of the rate the AP/expense legs used. NULL for a
     * domestic functional-currency invoice (rate is the 1.0 identity, never stored).
     */
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 6 }),
    /** Total freight being settled, in the DOCUMENT currency (ocean freight + THC + 내륙 summed in v1). */
    freightAmount: moneyCol('freight_amount').notNull(),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    /** Forwarder invoice / B/L reference number (optional in v1). */
    reference: varchar('reference', { length: 128 }),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('freight_settlement_posting_key_uq').on(t.companyCodeId, t.postingKey),
    unique('freight_settlement_doc_no_uq').on(t.docNo),
    check('freight_settlement_status_ck', sql`${t.status} = 'POSTED'`),
    check('freight_settlement_amount_nonneg_ck', sql`${t.freightAmount} >= 0`),
    index('freight_settlement_company_idx').on(t.companyCodeId),
    index('freight_settlement_shipment_idx').on(t.shipmentId),
  ],
);
