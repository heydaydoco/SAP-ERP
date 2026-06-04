import { numeric, pgEnum, pgTable, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';

/** VAT direction: OUTPUT on sales (매출세액), INPUT on purchases (매입세액). */
export const taxKind = pgEnum('tax_kind', ['OUTPUT', 'INPUT']);

/**
 * Tax code master (master-data.tax-code = 부가세 코드). A code + its rate; fi-posting / pricing compute
 * the tax amount through the kernel `Money.percentage` rounding (root CLAUDE.md §5.4 — the calc is
 * unit-tested). `glAccount` is the VAT account the tax line posts to (e.g. 2550 output VAT).
 */
export const taxCode = pgTable('tax_code', {
  id: pk(),
  code: varchar('code', { length: 8 }).notNull().unique(),
  name: varchar('name', { length: 128 }).notNull(),
  kind: taxKind('kind').notNull(),
  /** Percentage points, e.g. 10.0000 for 10% VAT. */
  ratePercent: numeric('rate_percent', { precision: 7, scale: 4 }).notNull(),
  glAccount: varchar('gl_account', { length: 16 }),
  ...auditColumns(),
});
