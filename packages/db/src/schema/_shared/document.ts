import { varchar } from 'drizzle-orm/pg-core';
import { auditColumns, lineNoCol, pk } from './columns';

/**
 * Common document framework column sets (root CLAUDE.md §4.2). Domains build their header/item
 * tables by spreading these, so every transaction document shares the same spine:
 * `[id + doc_type + doc_no + status + posting_key + audit-4]` for headers, `[id + line_no + audit-4]`
 * for items. The item→header foreign key is declared per table (it references that domain's header).
 */

export const documentHeaderColumns = () => ({
  id: pk(),
  docType: varchar('doc_type', { length: 32 }).notNull(),
  docNo: varchar('doc_no', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).notNull().default('DRAFT'),
  /** Idempotency key carried into fi-posting for exactly-once journals (§5.2). */
  postingKey: varchar('posting_key', { length: 128 }),
  ...auditColumns(),
});

export const documentItemColumns = () => ({
  id: pk(),
  lineNo: lineNoCol(),
  ...auditColumns(),
});
