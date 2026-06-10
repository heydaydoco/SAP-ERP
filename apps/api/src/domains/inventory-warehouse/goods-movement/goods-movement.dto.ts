import { paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/** Goods-movement request DTOs (Zod). */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    // Reject shaped-but-impossible dates like 2026-02-31 (must round-trip through UTC).
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

/**
 * Movement types in this slice (PO-free direct movements):
 * 561 initial load (+, priced) · 101 direct GR (+, priced) · 201 issue to cost center (−) ·
 * 711 inventory shortage (−) · 712 inventory surplus (+, valued at current MAP).
 */
export const movementTypeSchema = z.enum(['561', '101', '201', '711', '712']);
export type MovementType = z.infer<typeof movementTypeSchema>;

/** Movement types that carry an external unit price and recalculate the moving average. */
export const PRICED_TYPES: ReadonlySet<MovementType> = new Set(['561', '101']);
/** Movement types that DECREASE stock (valued at the current moving average). */
export const ISSUE_TYPES: ReadonlySet<MovementType> = new Set(['201', '711']);

/** Positive quantity, `NUMERIC(18,6)` shape. */
const qtySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'qty must be a non-negative decimal, max 6 decimals')
  .refine((v) => Number(v) > 0, 'qty must be positive');

/** Non-negative unit price, `NUMERIC(18,6)` shape (a rate — may be finer than the currency). */
const unitPriceSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'unitPrice must be a non-negative decimal, max 6 decimals');

export const goodsMovementItemSchema = z.object({
  materialId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  qty: qtySchema,
  /** REQUIRED on priced receipts (561/101); forbidden otherwise (the MAP prices those). */
  unitPrice: unitPriceSchema.optional(),
});

export const createGoodsMovementSchema = z
  .object({
    plantId: z.string().uuid(),
    movementType: movementTypeSchema,
    postingDate: isoDate,
    /** Business-event date; defaults to the posting date. */
    documentDate: isoDate.optional(),
    headerText: z.string().min(1).max(256).optional(),
    /**
     * Client idempotency key (§5.2) — supply one to make retries safe; minted when absent.
     * Scoped per plant. Capped at 120 (column 128) to keep derived-key headroom, mirroring FI.
     */
    postingKey: z.string().min(1).max(120).optional(),
    items: z.array(goodsMovementItemSchema).min(1).max(100),
  })
  .superRefine((dto, ctx) => {
    const priced = PRICED_TYPES.has(dto.movementType);
    dto.items.forEach((item, i) => {
      if (priced && item.unitPrice === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', i, 'unitPrice'],
          message: `movement type ${dto.movementType} is a priced receipt — unitPrice is required`,
        });
      }
      if (!priced && item.unitPrice !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', i, 'unitPrice'],
          message: `movement type ${dto.movementType} is valued at the moving average — unitPrice is not allowed`,
        });
      }
    });
  });
export type CreateGoodsMovementDto = z.infer<typeof createGoodsMovementSchema>;

export const goodsMovementQuerySchema = paginationQuerySchema.extend({
  plantId: z.string().uuid().optional(),
  movementType: movementTypeSchema.optional(),
});
export type GoodsMovementQuery = z.infer<typeof goodsMovementQuerySchema>;
