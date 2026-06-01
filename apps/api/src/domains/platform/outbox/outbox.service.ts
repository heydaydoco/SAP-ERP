import { Inject, Injectable } from '@nestjs/common';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';

export interface EnqueueOutbox {
  eventType: string;
  /** Idempotency key (UUID). Duplicate enqueues for the same id are no-ops. */
  eventId: string;
  payload: unknown;
}

/**
 * Transactional Outbox writer (root CLAUDE.md §5.2). Domains append events here in the SAME DB
 * transaction as the business change; the worker relay later publishes them exactly once. Enqueue
 * is idempotent via the unique `event_id` (`onConflictDoNothing`).
 *
 * Phase 2 passes the active transaction handle so the append is atomic with the posting; for now
 * it uses the shared connection.
 */
@Injectable()
export class OutboxService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async enqueue(input: EnqueueOutbox): Promise<void> {
    await this.db
      .insert(schema.outbox)
      .values({
        eventType: input.eventType,
        eventId: input.eventId,
        payload: input.payload,
        createdBy: 'system',
        updatedBy: 'system',
      })
      .onConflictDoNothing({ target: schema.outbox.eventId });
  }
}
