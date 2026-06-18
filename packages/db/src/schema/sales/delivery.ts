import { char, check, date, foreignKey, index, pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { quantityCol } from '../_shared/columns';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { goodsMovement } from '../inventory-warehouse/goods-movement';
import { plant } from '../platform/org-structure';
import { salesOrder, salesOrderItem } from './sales-order';

/**
 * Delivery (sales.delivery = SAP SD LIKP/LIPS essence) — a THIN shipping document. The physical goods
 * issue (재고차감 + COGS) is NOT a new engine: it IS a `goods_movement` (movement type 601), the SINGLE
 * source of stock changes → FI, posted via `GoodsMovementService.post(dto, actor, { offsetKey: 'COGS' })`
 * — so stock + valuation + the WA journal (**Dr COGS / Cr BSX**, both at the current moving average) +
 * `DELIVERS` PO… er, SO lineage commit in ONE transaction inside the engine (the §5.2 guarantee).
 *
 * This wrapper gives the shipment a business identity (출고전표) and ship-to snapshot, and ADOPTS the
 * goods movement's `GM-<year>` document number as its own `doc_no` (no separate range — §10). It is
 * idempotent on `goods_movement_id` (one delivery per GI): a replayed GI returns the same movement, so a
 * retry self-heals the wrapper. **Delivered quantity is DERIVED** from the `goods_movement_item.qty` via
 * the `DELIVERS` edges — there is NO delivered-qty counter on the SO line (D4); `delivery_item.qty` is
 * only this delivery note's own shipped line, never the open-qty source.
 */

export const delivery = pgTable(
  'delivery',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A delivery exists only once its GI is POSTED (GI is immediate in this slice; reversal is a follow-up). */
    status: varchar('status', { length: 16 }).notNull().default('POSTED'),
    salesOrderId: uuid('sales_order_id').notNull(),
    /** The GI goods movement this delivery wraps (601). UNIQUE = one delivery per movement (idempotency). */
    goodsMovementId: uuid('goods_movement_id').notNull(),
    /** Issuing plant (a movement is single-plant). */
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    /** Ship-to country snapshot (ISO-3166-1 alpha-2), copied from the SO at issue. */
    shipToCountry: char('ship_to_country', { length: 2 }),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('delivery_doc_no_uq').on(t.docNo),
    unique('delivery_gm_uq').on(t.goodsMovementId),
    check('delivery_status_ck', sql`${t.status} = 'POSTED'`),
    foreignKey({
      name: 'delivery_so_fk',
      columns: [t.salesOrderId],
      foreignColumns: [salesOrder.id],
    }),
    foreignKey({
      name: 'delivery_gm_fk',
      columns: [t.goodsMovementId],
      foreignColumns: [goodsMovement.id],
    }),
    index('delivery_so_idx').on(t.salesOrderId),
  ],
);

export const deliveryItem = pgTable(
  'delivery_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    deliveryId: uuid('delivery_id').notNull(),
    /** The SO item this delivery line ships (the DELIVERS edge carries the open-qty lineage in parallel). */
    salesOrderItemId: uuid('sales_order_item_id').notNull(),
    /** This delivery note's shipped quantity, NUMERIC(18,6); positive. NOT a cumulative counter (D4). */
    qty: quantityCol('qty').notNull(),
  },
  (t) => [
    unique('delivery_item_no_uq').on(t.deliveryId, t.lineNo),
    check('delivery_item_qty_pos_ck', sql`${t.qty} > 0`),
    foreignKey({
      name: 'delivery_item_delivery_fk',
      columns: [t.deliveryId],
      foreignColumns: [delivery.id],
    }),
    foreignKey({
      name: 'delivery_item_so_item_fk',
      columns: [t.salesOrderItemId],
      foreignColumns: [salesOrderItem.id],
    }),
    index('delivery_item_delivery_idx').on(t.deliveryId),
    index('delivery_item_so_item_idx').on(t.salesOrderItemId),
  ],
);
