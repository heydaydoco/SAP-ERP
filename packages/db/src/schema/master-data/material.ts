import { char, pgEnum, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk, quantityCol } from '../_shared/columns';

/**
 * Material master (master-data.material). The core record every MM/SD/PP/trade transaction references,
 * with per-area **extension tables** (§4.4): sales / purchasing / mrp / trade. This slice ships the
 * core + the `material_trade` extension (HS code + origin) the import/export business needs first.
 * `code` is the material number (natural key); base UoM is a unit code (uom master comes later).
 */

/** Mirrors the shared `materialTypeSchema`. */
export const materialType = pgEnum('material_type', [
  'FINISHED',
  'SEMI_FINISHED',
  'RAW',
  'TRADING',
  'SERVICE',
]);

export const material = pgTable('material', {
  id: pk(),
  /** Material number (business key), e.g. 'FG-1000'. */
  code: varchar('code', { length: 40 }).notNull().unique(),
  name: varchar('name', { length: 256 }).notNull(),
  materialType: materialType('material_type').notNull(),
  /** Base unit of measure code, e.g. 'EA' / 'KG' (uom master is a later slice). */
  baseUom: varchar('base_uom', { length: 8 }).notNull(),
  materialGroup: varchar('material_group', { length: 16 }),
  netWeight: quantityCol('net_weight'),
  weightUnit: varchar('weight_unit', { length: 8 }),
  ...auditColumns(),
});

/**
 * Trade extension (master-data.material_trade) — customs/trade attributes for import/export
 * (root CLAUDE.md §②: material = 품목 + HS코드 + 무역속성). 1:1 with the core material
 * (`material_id` unique). Feeds trade-compliance (HS classification, FTA origin) later.
 */
export const materialTrade = pgTable('material_trade', {
  id: pk(),
  materialId: uuid('material_id')
    .notNull()
    .unique()
    .references(() => material.id),
  /** HS classification code (관세 품목분류), digits only, e.g. '8471300000'. */
  hsCode: varchar('hs_code', { length: 16 }).notNull(),
  /** Country of origin, ISO-3166-1 alpha-2 (원산지). */
  countryOfOrigin: char('country_of_origin', { length: 2 }),
  /** Export control / strategic-goods classification, when applicable. */
  exportControlClass: varchar('export_control_class', { length: 16 }),
  ...auditColumns(),
});
