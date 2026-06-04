import { date, pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';
import { companyCode } from '../platform/org-structure';

/**
 * Cost center master (master-data.cost-center = 코스트센터) — the CO object FI expense lines carry.
 * Time-dependent (`validFrom`/`validTo`) and scoped to a company code; the code is unique within it.
 */
export const costCenter = pgTable(
  'cost_center',
  {
    id: pk(),
    code: varchar('code', { length: 16 }).notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    companyCodeId: uuid('company_code_id')
      .notNull()
      .references(() => companyCode.id),
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    responsible: varchar('responsible', { length: 64 }),
    ...auditColumns(),
  },
  (t) => [unique('cost_center_uq').on(t.companyCodeId, t.code)],
);
