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
 * Interface stub; concrete service + journal_entry/journal_line tables land in Phase 2 (FI),
 * with the contract reserved here in Phase 0.
 */

export interface JournalEntryInput {
  /** Idempotency key — same key never posts twice. */
  postingKey: string;
  postingDate: string; // ISO date; must fall in an open fiscal period (§5.1 period locking)
  currency: CurrencyCode;
  reference: string; // source doc reference, e.g. 'sales.billing:BIL-2026-0001'
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
