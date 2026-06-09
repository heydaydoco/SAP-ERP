import {
  currencyCodeSchema,
  drCrSchema,
  fxRateSchema,
  moneySchema,
  paginationQuerySchema,
} from '@erp/shared';
import { z } from 'zod';

/** Journal request DTOs (Zod). The manual-entry shape the controller maps onto the kernel input. */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    // Reject shaped-but-impossible dates like 2026-02-31 (must round-trip through UTC).
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

export const manualJournalLineSchema = z.object({
  /** GL account number within the company's chart of accounts. */
  glAccount: z.string().min(1).max(16),
  drCr: drCrSchema,
  /** Positive NUMERIC(18,4) magnitude — the sign lives in `drCr`, never in the number. */
  amount: moneySchema.refine((v) => Number(v) > 0, 'line amount must be positive'),
  costCenterId: z.string().uuid().optional(),
  lineText: z.string().min(1).max(256).optional(),
});

export const createManualJournalSchema = z.object({
  companyCodeId: z.string().uuid(),
  postingDate: isoDate,
  /** Business-event date; defaults to the posting date. */
  documentDate: isoDate.optional(),
  currency: currencyCodeSchema,
  /**
   * Optional FX-rate override (document→functional, units of functional per 1 unit of `currency`).
   * FX-only: omit for a functional-currency entry (supplying one there is rejected) and for any
   * entry whose 'M' master rate on the document date should apply. Scale ≤ 6.
   */
  fxRate: fxRateSchema.optional(),
  reference: z.string().min(1).max(128).default('manual'),
  headerText: z.string().min(1).max(256).optional(),
  /**
   * Client idempotency key (§5.2) — supply one to make retries safe; minted when absent. Scoped
   * per company code. Capped at 120 (not the column's 128) so the derived reversal key
   * `<key>:REV` always fits — keep the headroom.
   */
  postingKey: z.string().min(1).max(120).optional(),
  lines: z.array(manualJournalLineSchema).min(2).max(200),
});
export type CreateManualJournalDto = z.infer<typeof createManualJournalSchema>;

export const reverseJournalSchema = z.object({
  reason: z.string().min(1).max(256),
  /** Reversal posting date; defaults to today — must fall in an OPEN period (§5.1). */
  postingDate: isoDate.optional(),
});
export type ReverseJournalDto = z.infer<typeof reverseJournalSchema>;

export const journalQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  fiscalYear: z.coerce.number().int().optional(),
  periodNo: z.coerce.number().int().min(1).max(12).optional(),
});
export type JournalQuery = z.infer<typeof journalQuerySchema>;

export const trialBalanceQuerySchema = z.object({
  companyCodeId: z.string().uuid(),
  fiscalYear: z.coerce.number().int(),
  /** Omit to aggregate the whole fiscal year. */
  periodNo: z.coerce.number().int().min(1).max(12).optional(),
});
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;
