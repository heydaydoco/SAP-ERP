import { check, date, index, numeric, pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { currencyCol, moneyCol, quantityCol } from '../_shared/columns';
import { documentHeaderColumns, documentItemColumns } from '../_shared/document';
import { material } from '../master-data/material';
import { plant, storageLocation } from '../platform/org-structure';

/**
 * Goods movement document (inventory-warehouse.goods-movement = SAP MKPF/MSEG essence) — the
 * SINGLE source of stock changes → FI (domain CLAUDE.md). Extends the §4.2 document framework;
 * tightened like `journal_entry`: a movement exists only once POSTED (no DRAFT) and `posting_key`
 * is the NOT-NULL §5.2 idempotency gate (UNIQUE per plant — a replayed post returns the existing
 * document). Posted rows are immutable by convention (§5.1) — correction = reversal document,
 * deferred to a follow-up slice (hence no reversal columns yet).
 *
 * Movement types (SAP essence):
 *   561 initial stock load (+, priced, recalculates MAP) · 101 goods receipt (+, priced,
 *   recalculates MAP) · 201 goods issue to cost center (−, at current MAP) · 711 inventory
 *   shortage (−, at current MAP) · 712 inventory surplus (+, valued at current MAP, MAP-neutral) ·
 *   601 sales goods issue / delivery (−, at current MAP — COGS recognition; the O2C caller routes the
 *   offset to COGS instead of GBB). 601 is an ISSUE like 201/711 (no external price; MAP-valued).
 *
 * The FI journal is linked via a doc_flow edge (`inventory.goods_movement` → POSTS →
 * `finance.journal_entry`), never a bespoke FK (§4.3). Amounts are in the company's functional
 * currency (valuation currency) — the journal takes the KRW==KRW identity path.
 */

export const goodsMovement = pgTable(
  'goods_movement',
  {
    // §4.2 document spine: id, doc_type, doc_no, status, posting_key, audit-4.
    ...documentHeaderColumns(),
    /** A movement exists only once posted (no DRAFT; reversal is a follow-up slice). */
    status: varchar('status', { length: 16 }).notNull().default('POSTED'),
    /** Idempotency key (§5.2) — NOT NULL here; the UNIQUE below is the exactly-once gate. */
    postingKey: varchar('posting_key', { length: 128 }).notNull(),
    movementType: varchar('movement_type', { length: 3 }).notNull(),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    /** When the movement hits stock + GL — must fall in an OPEN period (checked by fi-posting). */
    postingDate: date('posting_date', { mode: 'string' }).notNull(),
    /** When the business event occurred (delivery note date, count date, …). */
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    /** Valuation currency of all item amounts — the plant's company functional currency. */
    currency: currencyCol('currency').notNull(),
    headerText: varchar('header_text', { length: 256 }),
  },
  (t) => [
    unique('goods_movement_posting_key_uq').on(t.plantId, t.postingKey),
    unique('goods_movement_doc_no_uq').on(t.docNo),
    check('goods_movement_status_ck', sql`${t.status} = 'POSTED'`),
    check(
      'goods_movement_type_ck',
      sql`${t.movementType} in ('561', '101', '201', '711', '712', '601')`,
    ),
    index('goods_movement_plant_date_idx').on(t.plantId, t.postingDate),
  ],
);

export const goodsMovementItem = pgTable(
  'goods_movement_item',
  {
    // §4.2 document item spine: id, line_no, audit-4.
    ...documentItemColumns(),
    goodsMovementId: uuid('goods_movement_id')
      .notNull()
      .references(() => goodsMovement.id),
    materialId: uuid('material_id')
      .notNull()
      .references(() => material.id),
    storageLocationId: uuid('storage_location_id')
      .notNull()
      .references(() => storageLocation.id),
    /** Always-positive magnitude; the direction lives in the header's movement_type. */
    qty: quantityCol('qty').notNull(),
    /** External price per unit — REQUIRED on priced receipts (561/101), absent otherwise. */
    unitPrice: numeric('unit_price', { precision: 18, scale: 6 }),
    /** The exact stock_value delta this item posted (= the journal line amount), NUMERIC(18,4).
     *  ALWAYS in the functional/valuation currency below — for an import GR the caller (procurement)
     *  has already translated the foreign value to KRW at the GR-date rate, so the engine and the MAP
     *  invariant stay functional-currency-only (KRW in → KRW out). */
    amount: moneyCol('amount').notNull(),
    currency: currencyCol('currency').notNull(),
    /**
     * Import-GR trade trace (all NULL for a domestic, functional-currency movement — the PO-free
     * REST path never sets them, so direct movements are byte-identical). A procurement import GR
     * stamps the FOREIGN document currency, the GR-date 'M' rate it translated at, and the foreign
     * value of the line, so the foreign basis survives for the GR/IR (입고미착) open report, the IV's
     * WRX relief reconstruction, and the next landed-cost slice. The valuation `amount`/`currency`
     * above are unaffected — they remain the KRW the engine posted.
     */
    documentCurrency: currencyCol('document_currency'),
    exchangeRate: numeric('exchange_rate', { precision: 18, scale: 6 }),
    documentAmount: moneyCol('document_amount'),
  },
  (t) => [
    unique('goods_movement_item_no_uq').on(t.goodsMovementId, t.lineNo),
    check('goods_movement_item_qty_pos_ck', sql`${t.qty} > 0`),
    check('goods_movement_item_amount_nonneg_ck', sql`${t.amount} >= 0`),
    check('goods_movement_item_unit_price_nonneg_ck', sql`${t.unitPrice} is null or ${t.unitPrice} >= 0`),
    check(
      'goods_movement_item_doc_amount_nonneg_ck',
      sql`${t.documentAmount} is null or ${t.documentAmount} >= 0`,
    ),
    index('goods_movement_item_material_idx').on(t.materialId),
  ],
);
