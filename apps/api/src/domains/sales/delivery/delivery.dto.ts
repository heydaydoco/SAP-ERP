import { z } from 'zod';

/** Delivery (goods-issue) request DTOs (Zod). A delivery issues lines of ONE sales order. */

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

export const deliveryItemSchema = z.object({
  salesOrderItemId: z.string().uuid(),
  qty: qtySchema,
  // No storage-location override: the GI issues from the SO line's own storage location (§8).
});

export const createDeliverySchema = z.object({
  salesOrderId: z.string().uuid(),
  postingDate: isoDate,
  /** Business-event date (delivery note date); defaults to the posting date. */
  documentDate: isoDate.optional(),
  headerText: z.string().min(1).max(256).optional(),
  /**
   * Client idempotency key (§5.2) for the underlying goods movement — supply one to make retries safe;
   * minted when absent. Scoped per plant. Capped at 120 (column 128) for derived-key headroom.
   */
  postingKey: z.string().min(1).max(120).optional(),
  items: z.array(deliveryItemSchema).min(1).max(100),
});
export type CreateDeliveryDto = z.infer<typeof createDeliverySchema>;
