import { glAccountTypeSchema, paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * GL-account request DTOs (Zod). `accountType` reuses the shared `glAccountTypeSchema` so the API,
 * DB enum, and fi-posting normal-balance logic stay in lock-step.
 */

const chartOfAccounts = z.string().min(1).max(16);
const accountNumber = z.string().min(1).max(16);

export const createGlAccountSchema = z.object({
  chartOfAccounts,
  accountNumber,
  name: z.string().min(1).max(128),
  accountType: glAccountTypeSchema,
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code')
    .optional(),
  isReconciliation: z.boolean().default(false),
});
export type CreateGlAccountDto = z.infer<typeof createGlAccountSchema>;

export const glAccountQuerySchema = paginationQuerySchema.extend({
  chartOfAccounts: chartOfAccounts.optional(),
});
export type GlAccountQuery = z.infer<typeof glAccountQuerySchema>;
