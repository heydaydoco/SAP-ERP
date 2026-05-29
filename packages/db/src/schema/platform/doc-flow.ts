import { index, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';

/**
 * Document Flow (root CLAUDE.md §4.3) — one generic graph tracing every chain
 * (quote→order→delivery→billing→FI, opportunity→order, reversals…). No bespoke FK link tables.
 */
export const docFlow = pgTable(
  'doc_flow',
  {
    id: pk(),
    sourceType: varchar('source_type', { length: 64 }).notNull(),
    sourceId: uuid('source_id').notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: uuid('target_id').notNull(),
    /** Relationship kind, e.g. 'REFERS_TO' | 'COPIED_FROM' | 'REVERSES'. */
    relType: varchar('rel_type', { length: 32 }).notNull(),
    ...auditColumns(),
  },
  (t) => [
    index('doc_flow_source_idx').on(t.sourceType, t.sourceId),
    index('doc_flow_target_idx').on(t.targetType, t.targetId),
  ],
);
