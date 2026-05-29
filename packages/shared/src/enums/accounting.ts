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
