import { sql } from 'drizzle-orm';
import { bigint, integer, pgTable, unique, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';

/**
 * Number ranges (platform.numbering = SAP Number Range). Every document's `doc_no` is drawn here.
 * Gap-free allocation is done with an atomic `UPDATE ... current_value = current_value + 1
 * RETURNING` (row lock serializes concurrent callers). One counter per (object, scope) — scope
 * lets a sequence reset/partition per year or org unit.
 */
export const numberRange = pgTable(
  'number_range',
  {
    id: pk(),
    /** Logical object, e.g. 'sales.sales_order'. */
    object: varchar('object', { length: 64 }).notNull(),
    /** Partition key for the counter, e.g. 'GLOBAL' or a fiscal year '2026'. */
    scope: varchar('scope', { length: 64 }).notNull().default('GLOBAL'),
    prefix: varchar('prefix', { length: 16 }).notNull().default(''),
    suffix: varchar('suffix', { length: 16 }).notNull().default(''),
    padding: integer('padding').notNull().default(6),
    currentValue: bigint('current_value', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    startValue: bigint('start_value', { mode: 'bigint' })
      .notNull()
      .default(sql`1`),
    endValue: bigint('end_value', { mode: 'bigint' }),
    ...auditColumns(),
  },
  (t) => [unique('number_range_uq').on(t.object, t.scope)],
);
