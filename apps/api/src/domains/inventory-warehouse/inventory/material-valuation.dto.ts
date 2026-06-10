import { currencyCodeSchema, paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/** Material-valuation ("accounting view") maintenance DTOs (Zod). */

export const ensureMaterialValuationSchema = z.object({
  materialId: z.string().uuid(),
  plantId: z.string().uuid(),
  /** §4.5 account-determination discriminator — picks the BSX/GBB rules. */
  valuationClass: z.string().min(1).max(16),
  /**
   * Optional sanity pin: when given it must equal the plant company's functional currency
   * (valuation is always kept in it; the row stores that currency either way).
   */
  currency: currencyCodeSchema.optional(),
});
export type EnsureMaterialValuationDto = z.infer<typeof ensureMaterialValuationSchema>;

export const materialValuationQuerySchema = paginationQuerySchema.extend({
  plantId: z.string().uuid().optional(),
  materialId: z.string().uuid().optional(),
});
export type MaterialValuationQuery = z.infer<typeof materialValuationQuerySchema>;

export const reconciliationQuerySchema = z.object({
  companyCodeId: z.string().uuid(),
});
export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>;
