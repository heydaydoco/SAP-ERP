import { z } from 'zod';

/** Goods-receipt request DTOs (Zod). A GR receives lines of ONE purchase order. */

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

export const goodsReceiptItemSchema = z.object({
  purchaseOrderItemId: z.string().uuid(),
  qty: qtySchema,
  /** Override the receiving storage location; defaults to the PO item's. */
  storageLocationId: z.string().uuid().optional(),
});

export const createGoodsReceiptSchema = z.object({
  purchaseOrderId: z.string().uuid(),
  postingDate: isoDate,
  /** Business-event date (delivery note date); defaults to the posting date. */
  documentDate: isoDate.optional(),
  headerText: z.string().min(1).max(256).optional(),
  /**
   * Client idempotency key (§5.2) for the underlying goods movement — supply one to make retries
   * safe; minted when absent. Scoped per plant. Capped at 120 (column 128) for derived-key headroom.
   */
  postingKey: z.string().min(1).max(120).optional(),
  items: z.array(goodsReceiptItemSchema).min(1).max(100),
});
export type CreateGoodsReceiptDto = z.infer<typeof createGoodsReceiptSchema>;
