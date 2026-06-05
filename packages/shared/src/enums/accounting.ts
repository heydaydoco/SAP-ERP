import { z } from 'zod';

/** Debit / Credit indicator for journal lines. */
export const drCrSchema = z.enum(['D', 'C']);
export type DrCr = z.infer<typeof drCrSchema>;

/** Document lifecycle status shared by the common document framework. */
export const docStatusSchema = z.enum([
  'DRAFT',
  'OPEN',
  'IN_PROCESS',
  'POSTED',
  'COMPLETED',
  'REVERSED',
  'CANCELLED',
]);
export type DocStatus = z.infer<typeof docStatusSchema>;

/** GL account classification (master-data.gl-account). Determines the account's normal balance. */
export const glAccountTypeSchema = z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']);
export type GlAccountType = z.infer<typeof glAccountTypeSchema>;

/**
 * The side on which an account type increases (its normal balance): assets and expenses are debit-
 * normal, liabilities/equity/revenue are credit-normal. This is a PRESENTATION/reporting concept
 * (trial-balance and statement signs), NOT a posting gate — both sides are legal on any account
 * (crediting an asset is how it decreases). fi-posting never rejects a line on normal balance.
 */
export function normalBalance(type: GlAccountType): DrCr {
  return type === 'ASSET' || type === 'EXPENSE' ? 'D' : 'C';
}

/** VAT (부가세) direction for a tax code: OUTPUT = on sales (매출), INPUT = on purchases (매입). */
export const taxKindSchema = z.enum(['OUTPUT', 'INPUT']);
export type TaxKind = z.infer<typeof taxKindSchema>;
