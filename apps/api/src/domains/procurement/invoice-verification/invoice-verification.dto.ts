import { currencyCodeSchema } from '@erp/shared';
import { z } from 'zod';

/** Invoice-verification request DTOs (Zod). Matches a vendor invoice to ONE purchase order. */

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

const unitPriceSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'unitPrice must be a non-negative decimal, max 6 decimals');

export const invoiceVerificationItemSchema = z.object({
  purchaseOrderItemId: z.string().uuid(),
  invoicedQty: qtySchema,
  invoiceUnitPrice: unitPriceSchema,
  /** Override the PO item's INPUT VAT code; omit to inherit it (or for a non-taxable line). */
  taxCode: z.string().min(1).max(16).optional(),
});

export const createInvoiceVerificationSchema = z.object({
  companyCodeId: z.string().uuid(),
  purchaseOrderId: z.string().uuid(),
  /** Vendor invoice / 세금계산서 number. */
  reference: z.string().min(1).max(128),
  postingDate: isoDate,
  /** Invoice (business-event) date — drives the derived AP due date. */
  documentDate: isoDate,
  currency: currencyCodeSchema,
  headerText: z.string().min(1).max(256).optional(),
  /** Client idempotency key (§5.2); minted when absent. Capped at 120 so derived keys fit 128. */
  postingKey: z.string().min(1).max(120).optional(),
  items: z.array(invoiceVerificationItemSchema).min(1).max(100),
});
export type CreateInvoiceVerificationDto = z.infer<typeof createInvoiceVerificationSchema>;
