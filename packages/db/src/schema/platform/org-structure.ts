import { char, pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, currencyCol, pk } from '../_shared/columns';

/**
 * Enterprise structure (platform.org-structure = SAP organizational units). The backbone every
 * later domain hangs off: company code (the accounting entity) → plant (operational site) →
 * storage location, plus sales/purchasing organizations. Codes are short business keys
 * (e.g. company '1000'); the surrogate uuid `id` is what other domains reference.
 *
 * Hierarchy is modeled with explicit foreign keys (not doc_flow — these are masters, not
 * transaction documents). Child codes are unique within their parent (composite unique), mirroring
 * SAP where a storage location code is meaningful only under its plant.
 */

/** Company code (회사코드) — the legal/accounting entity; owns a functional currency + chart of accounts. */
export const companyCode = pgTable('company_code', {
  id: pk(),
  /** Short business key, e.g. '1000'. */
  code: varchar('code', { length: 8 }).notNull().unique(),
  name: varchar('name', { length: 128 }).notNull(),
  /** Functional/local currency (ISO-4217); every amount in this entity travels with a currency (§3.1). */
  currency: currencyCol('currency').notNull(),
  /** ISO-3166-1 alpha-2 country. */
  country: char('country', { length: 2 }).notNull(),
  /** Chart-of-accounts key; account_determination (admin-config) resolves GL accounts within it. */
  chartOfAccounts: varchar('chart_of_accounts', { length: 16 }),
  ...auditColumns(),
});

/** Plant (사업장/공장) — an operational site under a company code (production / stock-keeping unit). */
export const plant = pgTable(
  'plant',
  {
    id: pk(),
    code: varchar('code', { length: 8 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    country: char('country', { length: 2 }),
    city: varchar('city', { length: 128 }),
    ...auditColumns(),
  },
  (t) => [unique('plant_uq').on(t.companyCodeId, t.code)],
);

/** Storage location (저장위치) — a stock-keeping subdivision of a plant. */
export const storageLocation = pgTable(
  'storage_location',
  {
    id: pk(),
    code: varchar('code', { length: 8 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    plantId: uuid('plant_id')
      .notNull()
      .references(() => plant.id),
    ...auditColumns(),
  },
  (t) => [
    unique('storage_location_uq').on(t.plantId, t.code),
    // (id, plant_id) target for composite FKs: lets dependents (inventory `stock`) pin their
    // denormalized plant_id to THIS location's plant at the DB level, not just in services.
    unique('storage_location_id_plant_uq').on(t.id, t.plantId),
  ],
);

/** Sales organization (영업조직) — the SD selling unit under a company code. */
export const salesOrg = pgTable(
  'sales_org',
  {
    id: pk(),
    code: varchar('code', { length: 8 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    /** Optional sales-org transaction currency; falls back to the company code's when absent. */
    currency: currencyCol('currency'),
    ...auditColumns(),
  },
  (t) => [unique('sales_org_uq').on(t.companyCodeId, t.code)],
);

/** Purchasing organization (구매조직) — the MM procuring unit under a company code. */
export const purchasingOrg = pgTable(
  'purchasing_org',
  {
    id: pk(),
    code: varchar('code', { length: 8 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    ...auditColumns(),
  },
  (t) => [unique('purchasing_org_uq').on(t.companyCodeId, t.code)],
);
