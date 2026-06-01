import { describe, it, expect, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InProcessEventBus } from './event-bus.service';
import type { DomainEvent } from '@erp/kernel';

describe('InProcessEventBus', () => {
  it('delivers a published event to subscribers of its type', async () => {
    const bus = new InProcessEventBus(new EventEmitter2());
    const handler = vi.fn();
    bus.subscribe('sales.billing.posted', handler);

    const event: DomainEvent<{ amount: string }> = {
      type: 'sales.billing.posted',
      eventId: 'evt-1',
      occurredAt: new Date(),
      payload: { amount: '11000.0000' },
    };
    await bus.publish(event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('does not deliver to unrelated subscribers', async () => {
    const bus = new InProcessEventBus(new EventEmitter2());
    const other = vi.fn();
    bus.subscribe('finance.ar.cleared', other);
    await bus.publish({
      type: 'sales.billing.posted',
      eventId: 'evt-2',
      occurredAt: new Date(),
      payload: {},
    });
    expect(other).not.toHaveBeenCalled();
  });
});
