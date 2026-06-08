import type { CurrencyCode } from '@erp/shared';
import type { PostingLine } from './balance';

/**
 * fi-posting service (root CLAUDE.md §3.2, §5.1, §5.2).
 *
 * The single path every value-moving transaction takes to the general ledger. Guarantees:
 *  - balanced double entry (see ./balance),
 *  - immutability + reversal-only correction (§5.1),
 *  - exactly-once via idempotency key (§5.2),
 *  - GL accounts resolved through account-determination config, never hard-coded (§4.5).
 *
 * Contract reserved in Phase 0; Phase 2 (FI) implements it concretely in
 * `apps/api/src/domains/finance-accounting` (journal_entry/journal_line). This is the SINGLE input
 * shape every caller uses — manual entries, AR/AP documents, and later domains alike.
 */

export interface JournalEntryInput {
  /** Idempotency key — same key never posts twice within its company code (§5.2). */
  postingKey: string;
  /** The posting org — drives the period lock, functional currency, and chart of accounts. */
  companyCodeId: string;
  postingDate: string; // ISO date; must fall in an open fiscal period (§5.1 period locking)
  /** Business-event date (SAP BLDAT); defaults to `postingDate` when omitted. */
  documentDate?: string;
  /** Document type (SAP BLART), e.g. 'SA' manual GL / 'AB' reversal; defaults to 'SA'. */
  docType?: string;
  /** Document (transaction) currency — every line's money must be in it. */
  currency: CurrencyCode;
  /**
   * Optional manual document→functional FX-rate override (units of functional per 1 unit of
   * `currency`, scale ≤ 6). FX-only: when omitted, `post()` resolves the 'M' rate from the fx_rate
   * master on `documentDate`. Supplying it on an entry already in the functional currency is
   * rejected. AR/AP invoices never set it (master rate only).
   */
  fxRate?: string;
  reference: string; // source doc reference, e.g. 'manual' or 'sales.billing:BIL-2026-0001'
  headerText?: string;
  lines: PostingLine[];
}

export interface PostedJournalEntry {
  journalId: string;
  postingKey: string;
  status: 'POSTED' | 'REVERSED';
}

export interface FiPostingService {
  /** Post a balanced entry; idempotent on `postingKey`. */
  post(input: JournalEntryInput): Promise<PostedJournalEntry>;
  /** Correct a posted entry by generating its reversal (never edit/delete the original). */
  reverse(journalId: string, reason: string): Promise<PostedJournalEntry>;
}
