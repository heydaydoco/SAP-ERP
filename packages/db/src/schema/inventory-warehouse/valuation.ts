import {
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, currencyCol, moneyCol, pk, quantityCol } from '../_shared/columns';
import { material } from '../master-data/material';
import { plant, storageLocation } from '../platform/org-structure';

/**
 * Inventory valuation + stock (inventory-warehouse.inventory = SAP MBEW/MARD essence).
 *
 * `material_valuation` follows the §4.4 master-extension pattern (like `material_trade`): the
 * material's "accounting view" per plant. It is the **reconciliation anchor**: `stock_value` is the
 * exact NUMERIC(18,4) amount that has flowed into the BSX inventory GL accounts for this
 * (material, plant) — Σ stock_value must equal the BSX GL balance at all times (the
 * /reconciliation endpoint proves it). `moving_avg_price` is DERIVED (stock_value / valuation_qty
 * at scale 6, display + issue-pricing aid); the value anchor is never recomputed from it.
 *
 * The row must exist (be "ensured") BEFORE the first goods movement — `GoodsMovementService`
 * locks it with SELECT FOR UPDATE to serialize MAP recalculation per (material, plant), so every
 * movement for the pair serializes on this row. `valuation_class` is the §4.5 account-determination
 * discriminator (BSX/GBB rules), introduced here because the valuation row IS the accounting view.
 *
 * `stock` holds quantity only, per (material, plant, storage location) — value lives ONLY on the
 * valuation row (plant-level MAP), so quantity and value cannot drift independently. The invariant
 * Σ stock.qty per (material, plant) == valuation_qty is kept by the movement service writing both
 * under the valuation row lock. `qty >= 0` is the DB backstop against over-issue races.
 */

export const materialValuation = pgTable(
  'material_valuation',
  {
    id: pk(),
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    /** Account-determination discriminator (§4.5) — picks the BSX/GBB rules for this material. */
    valuationClass: varchar('valuation_class', { length: 16 }).notNull(),
    /** Total valuated quantity at this plant (Σ stock.qty across its storage locations). */
    valuationQty: quantityCol('valuation_qty').notNull().default('0'),
    /**
     * Moving average price, DERIVED = stock_value / valuation_qty rounded half-away to scale 6.
     * Recomputed on quantity-increasing movements; issues leave it untouched (MAP-invariant) —
     * including the price kept after a full issue empties the stock (SAP VERPR behavior).
     */
    movingAvgPrice: numeric('moving_avg_price', { precision: 18, scale: 6 }).notNull().default('0'),
    /** The reconciliation anchor: exactly what sits on the BSX inventory account for this pair. */
    stockValue: moneyCol('stock_value').notNull().default('0'),
    /** Valuation currency — must be the company code's functional currency. */
    currency: currencyCol('currency').notNull(),
    /** Latest movement posting_date — the backdating guard (a movement may not post before it). */
    lastMovementDate: date('last_movement_date', { mode: 'string' }),
    ...auditColumns(),
  },
  (t) => [
    unique('material_valuation_uq').on(t.materialId, t.plantId),
    check('material_valuation_qty_nonneg_ck', sql`${t.valuationQty} >= 0`),
    check('material_valuation_value_nonneg_ck', sql`${t.stockValue} >= 0`),
    // Empty stock carries no value (a full issue clears the value exactly — no orphaned residue).
    check('material_valuation_empty_zero_ck', sql`${t.valuationQty} <> 0 or ${t.stockValue} = 0`),
  ],
);

export const stock = pgTable(
  'stock',
  {
    id: pk(),
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    /**
     * Denormalized from the storage location for plant-level sums. The composite FK below pins it
     * to the location's OWN plant at the DB level — a mismatched plant_id (which would silently
     * break Σ stock.qty == valuation_qty) is impossible to persist, service bug or not.
     */
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    storageLocationId: uuid('storage_location_id').notNull(),
    qty: quantityCol('qty').notNull().default('0'),
    ...auditColumns(),
  },
  (t) => [
    unique('stock_uq').on(t.materialId, t.storageLocationId),
    // DB backstop against over-issue (no negative stock in this slice).
    check('stock_qty_nonneg_ck', sql`${t.qty} >= 0`),
    // Existence AND plant-match in one constraint (targets storage_location_id_plant_uq).
    foreignKey({
      name: 'stock_sloc_plant_fk',
      columns: [t.storageLocationId, t.plantId],
      foreignColumns: [storageLocation.id, storageLocation.plantId],
    }),
    index('stock_plant_idx').on(t.materialId, t.plantId),
  ],
);
