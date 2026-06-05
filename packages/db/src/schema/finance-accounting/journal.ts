import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { currencyCol, moneyCol } from '../_shared/columns';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { businessPartner } from '../master-data/business-partner';
import { costCenter } from '../master-data/cost-center';
import { companyCode } from '../platform/org-structure';
import { fiscalPeriod } from '../platform/admin-config';

/**
 * General-ledger journal (finance-accounting.general-ledger = SAP BKPF/BSEG essence). The backbone
 * every value-moving transaction flows into via the kernel fi-posting service (root CLAUDE.md §3.2).
 *
 * Extends the common document framework (§4.2): the header spreads `documentHeaderColumns()` and
 * tightens two columns for FI's stricter contract — `status` defaults to 'POSTED' (a journal exists
 * only once posted; drafting/parking belongs to the SOURCE document's lifecycle, §5.1) and
 * `posting_key` is NOT NULL UNIQUE (the §5.2 exactly-once idempotency key; on the generic framework
 * it is the nullable key a source doc *carries into* fi-posting — here it IS the gate).
 *
 * Invariant enforcement is layered (§5.1, §5.4):
 *  - the posting service is the only writer and asserts balance through the kernel `assertBalanced`;
 *  - row-local invariants are CHECKs below (non-negative magnitudes, recon ⇒ partner, …);
 *  - migration 0008 adds hand-written DB backstops drizzle-kit cannot express: a DEFERRABLE
 *    INITIALLY DEFERRED constraint trigger re-checking Σdebit = Σcredit per (journal, document
 *    currency) at COMMIT, and immutability fences rejecting UPDATE/DELETE on posted rows (the only
 *    allowed UPDATE is the POSTED→REVERSED back-pointer flip).
 */

/** Debit/credit indicator (SAP SHKZG) — mirrors the shared `drCrSchema`. */
export const drCr = pgEnum('dr_cr', ['D', 'C']);

export const journalEntry = pgTable(
  'journal_entry',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** Journal lifecycle is POSTED → REVERSED only (no DRAFT — see header comment + CHECK below). */
    status: varchar('status', { length: 16 }).notNull().default('POSTED'),
    /**
     * Idempotency key (§5.2) — same key never posts twice WITHIN a company code; the composite
     * UNIQUE below is the DB exactly-once gate. Scoped per company so one tenant can neither
     * read nor hijack another's entry by guessing its key.
     */
    postingKey: varchar('posting_key', { length: 128 }).notNull(),
    /** The posting org — drives period lock, functional currency, and chart of accounts. */
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** When the entry hits the ledger (SAP BUDAT) — must fall in an OPEN period (§5.1). */
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    /** When the business event occurred (SAP BLDAT), e.g. the invoice date. */
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    /** Stamped from the covering period at post time (SAP GJAHR/MONAT — denormalized for reports). */
    fiscalYear: integer('fiscal_year').notNull(),
    periodNo: integer('period_no').notNull(),
    /** The exact open period this posted into — audit trail of the period-lock check. */
    fiscalPeriodId: uuid('fiscal_period_id')
      .notNull()
      .references(() => fiscalPeriod.id),
    /** Document (transaction) currency — what the entry was raised in (SAP WAERS). */
    currency: currencyCol('currency').notNull(),
    /** The company code's local currency; lines carry amounts translated into it. */
    functionalCurrency: currencyCol('functional_currency').notNull(),
    /** Doc→functional rate snapshot at posting; NULL while doc == functional (FX slice later). */
    fxRate: numeric('fx_rate', { precision: 18, scale: 6 }),
    /** Source-document reference, e.g. 'manual' or 'sales.billing:BIL-2026-0001'. */
    reference: varchar('reference', { length: 128 }).notNull(),
    headerText: varchar('header_text', { length: 256 }),
    /** Reversal lineage: the reversing doc points at the original… */
    reversalOfId: uuid('reversal_of_id'),
    /** …and the original points back at its reversal (set by the one fenced UPDATE). */
    reversedById: uuid('reversed_by_id'),
    reversalReason: varchar('reversal_reason', { length: 256 }),
  },
  (t) => [
    unique('journal_entry_posting_key_uq').on(t.companyCodeId, t.postingKey),
    unique('journal_entry_doc_no_uq').on(t.companyCodeId, t.fiscalYear, t.docNo),
    // A posted entry can be reversed at most once (Postgres treats NULLs as distinct).
    unique('journal_entry_reversed_by_uq').on(t.reversedById),
    foreignKey({
      name: 'journal_entry_reversal_of_fk',
      columns: [t.reversalOfId],
      foreignColumns: [t.id],
    }),
    foreignKey({
      name: 'journal_entry_reversed_by_fk',
      columns: [t.reversedById],
      foreignColumns: [t.id],
    }),
    check('journal_entry_status_ck', sql`${t.status} in ('POSTED', 'REVERSED')`),
    check('journal_entry_period_no_ck', sql`${t.periodNo} between 1 and 12`),
    // Reversal docs carry a reason; primary docs carry neither (0007 both-or-neither precedent).
    check(
      'journal_entry_reversal_pair_ck',
      sql`(${t.reversalOfId} is null) = (${t.reversalReason} is null)`,
    ),
    index('journal_entry_period_idx').on(t.companyCodeId, t.fiscalYear, t.periodNo),
    index('journal_entry_reference_idx').on(t.reference),
  ],
);

export const journalLine = pgTable(
  'journal_line',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntry.id),
    /** Resolved GL account number within the entry's chart (string, like recon accounts repo-wide). */
    glAccount: varchar('gl_account', { length: 16 }).notNull(),
    /** Debit/credit indicator — the sign lives HERE, never in the amount. */
    drCr: drCr('dr_cr').notNull(),
    /** Non-negative magnitude in the document currency. */
    amount: moneyCol('amount').notNull(),
    currency: currencyCol('currency').notNull(),
    /** The same line in the company's functional currency (== amount while doc == functional). */
    functionalAmount: moneyCol('functional_amount').notNull(),
    functionalCurrency: currencyCol('functional_currency').notNull(),
    /**
     * Snapshot of `gl_account.is_reconciliation` at post time. Manual postings to recon accounts
     * are blocked in the service (subledger paths in PR-B legally hit them); this column backs the
     * CHECK that a recon line always carries its subledger partner — the no-drift guarantee.
     */
    isReconAccount: boolean('is_recon_account').notNull().default(false),
    /** Subledger partner on AR/AP recon lines (PR-B); null on pure GL lines. */
    partnerId: uuid('partner_id').references(() => businessPartner.id),
    /** CO object on P&L lines only (service-enforced — account_type lives on the master). */
    costCenterId: uuid('cost_center_id').references(() => costCenter.id),
    /** Tax code that produced a VAT line (PR-B); the computed amount is frozen, the rate is not. */
    taxCode: varchar('tax_code', { length: 16 }),
    lineText: varchar('line_text', { length: 256 }),
  },
  (t) => [
    unique('journal_line_no_uq').on(t.journalEntryId, t.lineNo),
    check('journal_line_amount_nonneg_ck', sql`${t.amount} >= 0`),
    check('journal_line_functional_amount_nonneg_ck', sql`${t.functionalAmount} >= 0`),
    // Subledger/control-account no-drift backstop: a recon line must carry its partner.
    check(
      'journal_line_recon_partner_ck',
      sql`(not ${t.isReconAccount}) or (${t.partnerId} is not null)`,
    ),
    index('journal_line_entry_idx').on(t.journalEntryId),
    index('journal_line_gl_idx').on(t.glAccount, t.currency),
    index('journal_line_partner_idx').on(t.partnerId),
  ],
);
