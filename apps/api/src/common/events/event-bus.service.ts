import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEvent, EventBus, EventHandler } from '@erp/kernel';

/**
 * In-process domain event bus (root CLAUDE.md §4.7) backed by EventEmitter2. Synchronous fan-out
 * for same-transaction handlers; durable cross-domain delivery goes through the Outbox + worker
 * relay (§5.2), not this bus directly.
 */
@Injectable()
export class InProcessEventBus implements EventBus {
  constructor(private readonly emitter: EventEmitter2) {}

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    await this.emitter.emitAsync(event.type, event);
  }

  subscribe<T>(type: string, handler: EventHandler<T>): void {
    this.emitter.on(type, (event: DomainEvent<T>) => handler(event));
  }
}
