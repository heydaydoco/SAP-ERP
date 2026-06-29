import { bpTypeSchema, paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Business-partner request DTOs (Zod). The core partner + its role payloads (customer/vendor). Roles
 * default to the standard reconciliation accounts so a simple create needs no boilerplate.
 */

const reconAccount = z.string().min(1).max(16);
const currency = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code');
const money = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount must be a NUMERIC(18,4) decimal');
const paymentTermsDays = z.number().int().min(0).max(365).optional();

export const createBpSchema = z.object({
  code: z.string().min(1).max(16),
  name: z.string().min(1).max(200),
  bpType: bpTypeSchema,
  taxId: z.string().min(1).max(32).optional(),
  country: z
    .string()
    .length(2)
    .regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO-3166-1 alpha-2 code')
    .optional(),
  city: z.string().min(1).max(128).optional(),
  addressLine: z.string().min(1).max(256).optional(),
});
export type CreateBpDto = z.infer<typeof createBpSchema>;

export const createCustomerRoleSchema = z
  .object({
    arReconAccount: reconAccount.default('1100'),
    creditLimit: money.optional(),
    creditCurrency: currency.optional(),
    paymentTermsDays,
    salesBlock: z.boolean().default(false),
  })
  .refine((d) => (d.creditLimit === undefined) === (d.creditCurrency === undefined), {
    message: 'creditLimit and creditCurrency must be provided together',
  });
export type CreateCustomerRoleDto = z.infer<typeof createCustomerRoleSchema>;

export const createVendorRoleSchema = z.object({
  apReconAccount: reconAccount.default('2100'),
  paymentTermsDays,
  purchasingBlock: z.boolean().default(false),
});
export type CreateVendorRoleDto = z.infer<typeof createVendorRoleSchema>;

/**
 * Carrier role (운송인) — NON-POSTING, so no reconciliation account (unlike customer/vendor). Carries the
 * carrier's mode-split identity codes only; both optional (a 해상 carrier has only a SCAC, an 항공 carrier only
 * an IATA code, and the role may exist before either is keyed in). No cross-field rule — the role itself is the
 * flag. Empty strings are rejected by the 2-char minimum in each regex.
 */
export const createCarrierRoleSchema = z.object({
  /** SCAC — Standard Carrier Alpha Code, 2–4 uppercase letters (육상·해상 carrier). */
  scac: z
    .string()
    .regex(/^[A-Z]{2,4}$/, 'scac must be 2–4 uppercase letters (SCAC)')
    .optional(),
  /** IATA airline code — 2–3 alphanumeric uppercase (항공 carrier). */
  iataCode: z
    .string()
    .regex(/^[0-9A-Z]{2,3}$/, 'iataCode must be 2–3 uppercase alphanumeric (IATA airline code)')
    .optional(),
});
export type CreateCarrierRoleDto = z.infer<typeof createCarrierRoleSchema>;

export const bpQuerySchema = paginationQuerySchema.extend({
  bpType: bpTypeSchema.optional(),
});
export type BpQuery = z.infer<typeof bpQuerySchema>;
