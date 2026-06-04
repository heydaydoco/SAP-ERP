import { paginationQuerySchema, taxKindSchema } from '@erp/shared';
import { z } from 'zod';

/** Tax-code request DTOs (Zod). `kind` reuses the shared OUTPUT/INPUT enum; rate is percentage points. */

export const createTaxCodeSchema = z.object({
  code: z.string().min(1).max(8),
  name: z.string().min(1).max(128),
  kind: taxKindSchema,
  /** Percentage points, e.g. '10' for 10% VAT. */
  ratePercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,4})?$/, 'rate must be percentage points, e.g. "10"'),
  glAccount: z.string().min(1).max(16).optional(),
});
export type CreateTaxCodeDto = z.infer<typeof createTaxCodeSchema>;

export const taxCodeQuerySchema = paginationQuerySchema.extend({
  kind: taxKindSchema.optional(),
});
export type TaxCodeQuery = z.infer<typeof taxCodeQuerySchema>;

export const taxQuoteSchema = z.object({
  baseAmount: z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount must be a NUMERIC(18,4) decimal'),
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code'),
});
export type TaxQuoteQuery = z.infer<typeof taxQuoteSchema>;
