/**
 * Domain event bus (root CLAUDE.md §4.7).
 *
 * Emit domain events (`BillingPosted`, …); AR/FI/Treasury/analytics subscribe.
 * In-process EventEmitter for sync; BullMQ for async. Reliable delivery uses the Outbox (§5.2).
 *
 * Interface stubs only — concrete EventEmitter2 + BullMQ wiring lands in Phase 0.
 */

export interface DomainEvent<TPayload = unknown> {
  /** Dotted, past-tense name, e.g. 'sales.billing.posted'. */
  type: string;
  /** Unique id — doubles as the idempotency key downstream (§5.2). */
  eventId: string;
  occurredAt: Date;
  payload: TPayload;
}

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => Promise<void> | void;

export interface EventBus {
  publish<T>(event: DomainEvent<T>): Promise<void>;
  subscribe<T>(type: string, handler: EventHandler<T>): void;
}
