import { char, integer, numeric, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { MONEY_DB_PRECISION, MONEY_DB_SCALE } from '@erp/kernel';

/**
 * Shared column builders — the physical contract behind the global rules (root CLAUDE.md §3).
 * Every table composes these so the rules are defined once, never re-implemented per table.
 */

/** UUID primary key, server-generated. */
export const pk = () => uuid('id').primaryKey().defaultRandom();

/**
 * The mandated audit-4 columns on EVERY table (§3.4). `*_by` holds the actor (user id / 'system').
 * Spread into a table definition: `{ ...auditColumns() }`.
 */
export const auditColumns = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: varchar('created_by', { length: 64 }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 64 }).notNull(),
});

/** Currency-aware money column, NUMERIC(18,4) for every currency (§3.1). Pair with `currencyCol`. */
export const moneyCol = (name: string) =>
  numeric(name, { precision: MONEY_DB_PRECISION, scale: MONEY_DB_SCALE });

/** ISO-4217 currency code. */
export const currencyCol = (name = 'currency') => char(name, { length: 3 });

/** Quantity / rate column at higher scale than money (§3.1 allows it). */
export const quantityCol = (name: string) => numeric(name, { precision: 18, scale: 6 });

/** Monotonic line number for document items. */
export const lineNoCol = () => integer('line_no').notNull();
