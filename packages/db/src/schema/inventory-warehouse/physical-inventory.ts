import { check, date, foreignKey, index, pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { quantityCol } from '../_shared/columns';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { material } from '../master-data/material';
import { plant, storageLocation } from '../platform/org-structure';

/**
 * Physical inventory / stock-count document (inventory-warehouse.physical-inventory = SAP MI01/MI07
 * essence) — a THIN counting document. The actual stock adjustment (재고 증감 + FI 재고조정손익) is NOT a
 * new engine: each non-zero line difference IS a `goods_movement` (movement type **701** stock gain /
 * **702** stock loss), the SINGLE source of stock changes → FI, posted via
 * `GoodsMovementService.post(dto, actor, { offsetKey: 'IDI' })` — so stock + valuation (at the current
 * MAP) + the journal (**701: Dr BSX / Cr IDI**, **702: Dr IDI / Cr BSX**) + `ADJUSTS` lineage commit in
 * ONE transaction inside the engine (the §5.2 guarantee).
 *
 * This wrapper records the count itself: the `book_qty` SNAPSHOT (taken from `stock.qty` at the counted
 * storage location), the entered `physical_qty`, and their `diff_qty` (= physical − book, which may be
 * NEGATIVE for a loss). `book_qty`/`physical_qty`/`diff_qty` are the count's own inputs/snapshot — NOT a
 * derived counter of the adjustment (D4): the adjustment quantity IS the `goods_movement_item.qty`, and
 * the doc → movement link is the generic `ADJUSTS` doc_flow edge (no bespoke counter column, §4.3).
 *
 * Idempotent on `posting_key` (NOT NULL, UNIQUE per plant — a replayed count returns the existing
 * document); `status` is COUNTED until every required 701/702 adjustment has posted, then POSTED. A doc
 * with only zero diffs goes straight to POSTED (no movement, no journal). Posted-immutable like the rest
 * of the doc framework (§5.1) — correction is a future re-count, never an edit.
 */

export const physicalInventoryDoc = pgTable(
  'physical_inventory_doc',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** COUNTED once the snapshot is recorded; POSTED once every required 701/702 adjustment has posted. */
    status: varchar('status', { length: 16 }).notNull().default('COUNTED'),
    /** Idempotency key (§5.2) — NOT NULL here; the UNIQUE below is the exactly-once gate (per plant). */
    postingKey: varchar('posting_key', { length: 128 }).notNull(),
    /** The plant counted (a goods movement is single-plant; every line counts in this plant). */
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    /** When the adjustment posts to stock + GL — must fall in an OPEN period (checked by fi-posting). */
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    /** When the count was taken (business-event date). */
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('physical_inventory_doc_doc_no_uq').on(t.docNo),
    unique('physical_inventory_doc_posting_key_uq').on(t.plantId, t.postingKey),
    check('physical_inventory_doc_status_ck', sql`${t.status} in ('COUNTED', 'POSTED')`),
    index('physical_inventory_doc_plant_date_idx').on(t.plantId, t.postingDate),
  ],
);

export const physicalInventoryItem = pgTable(
  'physical_inventory_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    physicalInventoryDocId: uuid('physical_inventory_doc_id').notNull(),
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    /** Counted plant; pinned to the storage location's own plant by the composite FK below. */
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    /** Counted storage location (book_qty is its `stock.qty` snapshot). */
    storageLocationId: uuid('storage_location_id').notNull(),
    /** Book quantity at count time (snapshot of `stock.qty` for this material + storage location). */
    bookQty: quantityCol('book_qty').notNull(),
    /** Physically counted quantity (entered). */
    physicalQty: quantityCol('physical_qty').notNull(),
    /** physical − book; NEGATIVE for a loss (702), positive for a gain (701) — NO sign CHECK. */
    diffQty: quantityCol('diff_qty').notNull(),
  },
  (t) => [
    unique('physical_inventory_item_no_uq').on(t.physicalInventoryDocId, t.lineNo),
    check('physical_inventory_item_book_nonneg_ck', sql`${t.bookQty} >= 0`),
    check('physical_inventory_item_phys_nonneg_ck', sql`${t.physicalQty} >= 0`),
    // diff_qty is exactly physical − book (a convenience column kept consistent at the DB level).
    check('physical_inventory_item_diff_ck', sql`${t.diffQty} = ${t.physicalQty} - ${t.bookQty}`),
    // Explicit FK names (auto names would exceed Postgres's 63-char limit and silently truncate).
    foreignKey({
      name: 'physical_inventory_item_doc_fk',
      columns: [t.physicalInventoryDocId],
      foreignColumns: [physicalInventoryDoc.id],
    }),
    // Existence AND plant-match in one constraint (targets storage_location_id_plant_uq), like sales item.
    foreignKey({
      name: 'physical_inventory_item_sloc_plant_fk',
      columns: [t.storageLocationId, t.plantId],
      foreignColumns: [storageLocation.id, storageLocation.plantId],
    }),
    index('physical_inventory_item_doc_idx').on(t.physicalInventoryDocId),
    index('physical_inventory_item_material_idx').on(t.materialId),
  ],
);
