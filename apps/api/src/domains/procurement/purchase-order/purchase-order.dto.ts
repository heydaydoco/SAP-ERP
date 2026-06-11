import { currencyCodeSchema, paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/** Purchase-order request DTOs (Zod). */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

/** Positive quantity, NUMERIC(18,6) shape. */
const qtySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'qty must be a non-negative decimal, max 6 decimals')
  .refine((v) => Number(v) > 0, 'qty must be positive');

/** Non-negative unit price, NUMERIC(18,6) shape (a rate — may be finer than the currency). */
const unitPriceSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'unitPrice must be a non-negative decimal, max 6 decimals');

export const purchaseOrderItemSchema = z.object({
  materialId: z.string().uuid(),
  /** Receiving plant; its material valuation (accounting view) must exist for GR. */
  plantId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  orderedQty: qtySchema,
  unitPrice: unitPriceSchema,
  /** INPUT VAT code IV applies to this line; omit for a non-taxable line. */
  taxCode: z.string().min(1).max(16).optional(),
});

export const createPurchaseOrderSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** Vendor business-partner id (must carry a vendor role). */
  vendorBpId: z.string().uuid(),
  purchasingOrgId: z.string().uuid().optional(),
  currency: currencyCodeSchema,
  orderDate: isoDate,
  headerText: z.string().min(1).max(256).optional(),
  items: z.array(purchaseOrderItemSchema).min(1).max(200),
});
export type CreatePurchaseOrderDto = z.infer<typeof createPurchaseOrderSchema>;

export const purchaseOrderQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  vendorBpId: z.string().uuid().optional(),
});
export type PurchaseOrderQuery = z.infer<typeof purchaseOrderQuerySchema>;
