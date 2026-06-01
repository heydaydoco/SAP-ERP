import { index, integer, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';

/**
 * Transactional Outbox (root CLAUDE.md §5.2) — exactly-once delivery for domain-event chains
 * (BillingPosted→AR→FI→Treasury). Rows are written in the same DB transaction as the business
 * change; the worker relay publishes them and marks SENT. `event_id` is unique so enqueue is
 * idempotent and consumers dedupe on it.
 */
export const outboxStatus = pgEnum('outbox_status', ['PENDING', 'SENT', 'FAILED']);

export const outbox = pgTable(
  'outbox',
  {
    id: pk(),
    eventType: varchar('event_type', { length: 128 }).notNull(),
    eventId: uuid('event_id').notNull().unique(),
    payload: jsonb('payload').notNull(),
    status: outboxStatus('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: varchar('last_error', { length: 1024 }),
    ...auditColumns(),
  },
  (t) => [index('outbox_dispatch_idx').on(t.status, t.availableAt)],
);
