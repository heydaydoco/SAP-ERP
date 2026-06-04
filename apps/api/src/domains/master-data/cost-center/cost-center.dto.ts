import { paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/** Cost-center request DTOs (Zod). Scoped to a company code; time-dependent validity is optional. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');

export const createCostCenterSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1).max(128),
  companyCodeId: z.string().uuid(),
  validFrom: isoDate.optional(),
  validTo: isoDate.optional(),
  responsible: z.string().min(1).max(64).optional(),
});
export type CreateCostCenterDto = z.infer<typeof createCostCenterSchema>;

export const costCenterQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
});
export type CostCenterQuery = z.infer<typeof costCenterQuerySchema>;
