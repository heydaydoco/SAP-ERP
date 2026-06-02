import { paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Admin-config request DTOs (Zod, validated at the edge — root CLAUDE.md §3.7).
 * Covers fiscal-period control and account-determination rule maintenance.
 */

// ── fiscal periods ───────────────────────────────────────────────────────────

export const generateFiscalYearSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** Calendar year; generates 12 monthly periods, all OPEN. */
  year: z.number().int().min(2000).max(2100),
});
export type GenerateFiscalYearDto = z.infer<typeof generateFiscalYearSchema>;

export const fiscalYearsQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
});
export type FiscalYearsQuery = z.infer<typeof fiscalYearsQuerySchema>;

// ── account determination ─────────────────────────────────────────────────────

const optKey = z.string().max(16).optional();

export const createAccountDeterminationSchema = z.object({
  chartOfAccounts: z.string().min(1).max(16),
  transactionKey: z.string().min(1).max(32),
  valuationClass: optKey,
  materialGroup: optKey,
  taxCode: optKey,
  companyCode: z.string().max(8).optional(),
  glAccount: z.string().min(1).max(16),
});
export type CreateAccountDeterminationDto = z.infer<typeof createAccountDeterminationSchema>;

export const accountDeterminationQuerySchema = paginationQuerySchema.extend({
  chartOfAccounts: z.string().min(1).max(16).optional(),
});
export type AccountDeterminationQuery = z.infer<typeof accountDeterminationQuerySchema>;

/** Query params for the resolve diagnostic endpoint. */
export const resolveAccountQuerySchema = z.object({
  chartOfAccounts: z.string().min(1).max(16),
  transactionKey: z.string().min(1).max(32),
  valuationClass: optKey,
  materialGroup: optKey,
  taxCode: optKey,
  companyCode: z.string().max(8).optional(),
});
export type ResolveAccountQuery = z.infer<typeof resolveAccountQuerySchema>;
