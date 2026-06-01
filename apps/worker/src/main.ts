import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { createDb } from '@erp/db';
import { runOutboxRelay } from './outbox-relay.js';

/**
 * BullMQ worker host. Phase 0 ships the Outbox relay (kernel §5.2): it polls the `outbox` table and
 * publishes domain events exactly-once. Async event-bus handlers and scheduled batch jobs
 * (period-close, MV refresh, connector polling) register here in later phases.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://erp:erp@localhost:5432/erp';
const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 1000);

export const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
export const OUTBOX_QUEUE = 'erp.outbox';
export const outboxQueue = new Queue(OUTBOX_QUEUE, { connection });

async function bootstrap(): Promise<void> {
  const db = createDb(DATABASE_URL);
  console.warn(`[worker] online — outbox relay polling every ${POLL_MS}ms`);

  const tick = async (): Promise<void> => {
    try {
      const relayed = await runOutboxRelay(db, outboxQueue);
      if (relayed > 0) console.warn(`[worker] relayed ${relayed} outbox event(s)`);
    } catch (err) {
      console.error('[worker] outbox relay error', err);
    }
  };

  setInterval(() => void tick(), POLL_MS);
}

void bootstrap();
