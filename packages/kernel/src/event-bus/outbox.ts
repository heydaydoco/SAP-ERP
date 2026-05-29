/**
 * Transactional Outbox (root CLAUDE.md §5.2) — exactly-once delivery for event chains
 * (BillingPosted→AR→FI→Treasury). The event row is written in the same DB transaction as the
 * business change; a relay publishes it and marks it sent. Consumers dedupe on `eventId`.
 *
 * Interface stub; the `outbox` table + relay worker land in Phase 0.
 */
export type OutboxStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface OutboxRecord {
  id: string;
  eventType: string;
  eventId: string;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  createdAt: Date;
  sentAt?: Date;
}

export interface OutboxRelay {
  /** Append within the current DB transaction. */
  enqueue(record: Omit<OutboxRecord, 'id' | 'status' | 'attempts' | 'createdAt'>): Promise<void>;
  /** Publish pending records; idempotent. */
  flush(): Promise<void>;
}
