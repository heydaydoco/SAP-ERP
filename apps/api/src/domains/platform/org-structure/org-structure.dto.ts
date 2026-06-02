import { paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Org-structure request DTOs (Zod, validated at the edge by ZodValidationPipe — root CLAUDE.md §3.7).
 * Codes are short business keys; `currency`/`country` follow ISO-4217 / ISO-3166-1 alpha-2.
 */

const code = z.string().min(1).max(8);
const name = z.string().min(1).max(128);
const currency = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code');
const country = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO-3166-1 alpha-2 code');

export const createCompanyCodeSchema = z.object({
  code,
  name,
  currency,
  country,
  chartOfAccounts: z.string().min(1).max(16).optional(),
});
export type CreateCompanyCodeDto = z.infer<typeof createCompanyCodeSchema>;

export const createPlantSchema = z.object({
  code,
  name,
  companyCodeId: z.string().uuid(),
  country: country.optional(),
  city: z.string().min(1).max(128).optional(),
});
export type CreatePlantDto = z.infer<typeof createPlantSchema>;

export const createStorageLocationSchema = z.object({
  code,
  name,
  plantId: z.string().uuid(),
});
export type CreateStorageLocationDto = z.infer<typeof createStorageLocationSchema>;

export const createSalesOrgSchema = z.object({
  code,
  name,
  companyCodeId: z.string().uuid(),
  currency: currency.optional(),
});
export type CreateSalesOrgDto = z.infer<typeof createSalesOrgSchema>;

export const createPurchasingOrgSchema = z.object({
  code,
  name,
  companyCodeId: z.string().uuid(),
});
export type CreatePurchasingOrgDto = z.infer<typeof createPurchasingOrgSchema>;

// ── list query schemas (pagination + optional parent filter) ─────────────────

export const byCompanyQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
});
export type ByCompanyQuery = z.infer<typeof byCompanyQuerySchema>;

export const byPlantQuerySchema = paginationQuerySchema.extend({
  plantId: z.string().uuid().optional(),
});
export type ByPlantQuery = z.infer<typeof byPlantQuerySchema>;
