import { currencyCodeSchema } from '@erp/shared';
import { z } from 'zod';

/** Billing request DTOs (Zod). Bills DELIVERED quantities of ONE sales order. Mirror of the IV DTO. */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

const qtySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'qty must be a non-negative decimal, max 6 decimals')
  .refine((v) => Number(v) > 0, 'qty must be positive');

export const billingItemSchema = z.object({
  salesOrderItemId: z.string().uuid(),
  /** Quantity to bill (≤ open-to-bill = delivered − billed). The net is qty × the SO line's unit price. */
  qty: qtySchema,
  /** Revenue GL account this line credits (D: from the document, not VKOA). */
  revenueAccount: z.string().min(1).max(16),
  /** Override the SO item's OUTPUT VAT code; omit to inherit it (or for a non-taxable line). */
  taxCode: z.string().min(1).max(16).optional(),
  lineText: z.string().min(1).max(256).optional(),
});

export const createBillingSchema = z.object({
  companyCodeId: z.string().uuid(),
  salesOrderId: z.string().uuid(),
  /** Customer invoice / 세금계산서 number. */
  reference: z.string().min(1).max(128),
  postingDate: isoDate,
  /**
   * Invoice (business-event) date — drives the FX translation: a foreign (export) billing translates
   * every line at THIS date's 'M' rate (a single rate per billing). Required, like an AR invoice.
   */
  documentDate: isoDate,
  /** Must equal the SO currency (§11 — one currency per SO). */
  currency: currencyCodeSchema,
  headerText: z.string().min(1).max(256).optional(),
  /** Client idempotency key (§5.2); minted when absent. Capped at 120 so derived keys fit 128. */
  postingKey: z.string().min(1).max(120).optional(),
  items: z.array(billingItemSchema).min(1).max(100),
});
export type CreateBillingDto = z.infer<typeof createBillingSchema>;
