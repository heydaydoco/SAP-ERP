import { paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Currency + fx-rate request DTOs (Zod, validated at the edge — root CLAUDE.md §3.7). Codes are
 * ISO-4217; `minorUnit` is capped at the money DB scale (4); rates/dates are decimal/ISO strings.
 */

const currencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
const decimal = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'must be a positive decimal string');

export const createCurrencySchema = z.object({
  code: currencyCode,
  name: z.string().min(1).max(64),
  /** Minor-unit exponent (decimal places); 0..4 to fit NUMERIC(18,4). */
  minorUnit: z.number().int().min(0).max(4),
  symbol: z.string().min(1).max(8).optional(),
});
export type CreateCurrencyDto = z.infer<typeof createCurrencySchema>;

export const createFxRateSchema = z.object({
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  rateType: z.string().min(1).max(4).default('M'),
  validFrom: isoDate,
  rate: decimal,
});
export type CreateFxRateDto = z.infer<typeof createFxRateSchema>;

export const fxRateQuerySchema = paginationQuerySchema.extend({
  fromCurrency: currencyCode.optional(),
  toCurrency: currencyCode.optional(),
});
export type FxRateQuery = z.infer<typeof fxRateQuerySchema>;

export const resolveFxRateSchema = z.object({
  fromCurrency: currencyCode,
  toCurrency: currencyCode,
  onDate: isoDate,
  rateType: z.string().min(1).max(4).default('M'),
});
export type ResolveFxRateQuery = z.infer<typeof resolveFxRateSchema>;
