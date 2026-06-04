import { materialTypeSchema, paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Material request DTOs (Zod). The core material + its trade extension payload. `material_type`
 * reuses the shared enum so the API, DB enum, and downstream MM/SD logic stay in lock-step.
 */

const decimal = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'must be a positive decimal string');

export const createMaterialSchema = z
  .object({
    code: z.string().min(1).max(40),
    name: z.string().min(1).max(256),
    materialType: materialTypeSchema,
    baseUom: z.string().min(1).max(8),
    materialGroup: z.string().min(1).max(16).optional(),
    netWeight: decimal.optional(),
    weightUnit: z.string().min(1).max(8).optional(),
  })
  .refine((d) => (d.netWeight === undefined) === (d.weightUnit === undefined), {
    message: 'netWeight and weightUnit must be provided together',
  });
export type CreateMaterialDto = z.infer<typeof createMaterialSchema>;

export const createTradeDataSchema = z.object({
  hsCode: z.string().regex(/^\d{6,10}$/, 'hsCode must be 6–10 digits'),
  countryOfOrigin: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO-3166-1 alpha-2 code')
    .optional(),
  exportControlClass: z.string().min(1).max(16).optional(),
});
export type CreateTradeDataDto = z.infer<typeof createTradeDataSchema>;

export const materialQuerySchema = paginationQuerySchema.extend({
  materialType: materialTypeSchema.optional(),
  materialGroup: z.string().min(1).max(16).optional(),
});
export type MaterialQuery = z.infer<typeof materialQuerySchema>;
