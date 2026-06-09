import { moneySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Clearing (payment) request DTOs (Zod). v1 is MANUAL, FULL clearing of one designated open item:
 * the caller names the open invoice document (`journalId`) and the partner; the recon account, the
 * document currency, and the original functional value are read off that open recon line, the cash
 * account comes from `account_determination` (no hard-coded posting accounts, §4.5), and realized FX
 * gain/loss is recognized for foreign items. Partial clearing, payment runs, and bank-master /
 * bank-reconciliation are out of v1 scope.
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

export const createClearingSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** The customer/vendor whose open recon line is being cleared. */
  partnerId: z.string().uuid(),
  /** The open invoice document (its journal_entry id) to clear in full. */
  journalId: z.string().uuid(),
  /**
   * Clearing/settlement date — drives the period lock AND the settlement-date FX rate used to
   * recognize realized gain/loss against the open item's original functional value.
   */
  postingDate: isoDate,
  /** Business-event date for the FX rate (SAP WWERT); defaults to `postingDate`. */
  documentDate: isoDate.optional(),
  /**
   * Full-clearing guard (v1): if supplied, MUST equal the open item's gross (document currency),
   * else the clear is rejected — partial clearing is out of scope.
   */
  amount: moneySchema.optional(),
  reference: z.string().min(1).max(128).optional(),
  headerText: z.string().min(1).max(256).optional(),
  /**
   * Client idempotency key (§5.2); defaults to `clr:<journalId>` (deterministic per invoice).
   * Capped at 120 so `<key>:REV` fits 128. Re-clearing an item that was reset needs a NEW key.
   */
  postingKey: z.string().min(1).max(120).optional(),
});
export type CreateClearingDto = z.infer<typeof createClearingSchema>;

export const resetClearingSchema = z.object({
  reason: z.string().min(1).max(256),
  /** Reset (reversal) posting date; defaults to today. The original clearing period stays closed. */
  postingDate: isoDate.optional(),
});
export type ResetClearingDto = z.infer<typeof resetClearingSchema>;
