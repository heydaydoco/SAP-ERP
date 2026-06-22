import { paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/** Physical-inventory (재고 실사) request DTOs (Zod). */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    // Reject shaped-but-impossible dates like 2026-02-31 (must round-trip through UTC).
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

/** Non-negative counted quantity, `NUMERIC(18,6)` shape — a count of ZERO is legitimate (full loss). */
const countQtySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'physicalQty must be a non-negative decimal, max 6 decimals');

export const physicalInventoryItemSchema = z.object({
  materialId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  /** The physically counted quantity at this storage location (book_qty is snapshotted server-side). */
  physicalQty: countQtySchema,
});

export const createPhysicalInventorySchema = z.object({
  plantId: z.string().uuid(),
  postingDate: isoDate,
  /** Count (business-event) date; defaults to the posting date. */
  documentDate: isoDate.optional(),
  /**
   * Client idempotency key (§5.2) — REQUIRED (the count document's NOT-NULL replay gate, UNIQUE per
   * plant). A replayed count returns the existing document. Capped at 120 (column 128) for headroom.
   */
  postingKey: z.string().min(1).max(120),
  headerText: z.string().min(1).max(256).optional(),
  items: z.array(physicalInventoryItemSchema).min(1).max(100),
});
export type CreatePhysicalInventoryDto = z.infer<typeof createPhysicalInventorySchema>;

export const physicalInventoryQuerySchema = paginationQuerySchema.extend({
  plantId: z.string().uuid().optional(),
});
export type PhysicalInventoryQuery = z.infer<typeof physicalInventoryQuerySchema>;
