import { and, eq, lte } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import type { Queue } from 'bullmq';

const BATCH_SIZE = 100;

/**
 * Outbox relay (root CLAUDE.md §5.2). Publishes PENDING outbox rows to the queue using
 * `jobId = event_id` so BullMQ dedupes — exactly-once even if a row is processed twice — then marks
 * them SENT. Run on an interval by the worker. Returns how many rows were relayed.
 */
export async function runOutboxRelay(db: Database, queue: Queue): Promise<number> {
  const pending = await db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.status, 'PENDING'), lte(schema.outbox.availableAt, new Date())))
    .limit(BATCH_SIZE);

  for (const row of pending) {
    await queue.add(
      row.eventType,
      { eventId: row.eventId, payload: row.payload },
      { jobId: row.eventId, removeOnComplete: true },
    );
    await db
      .update(schema.outbox)
      .set({ status: 'SENT', sentAt: new Date(), updatedAt: new Date(), updatedBy: 'outbox-relay' })
      .where(eq(schema.outbox.id, row.id));
  }

  return pending.length;
}
