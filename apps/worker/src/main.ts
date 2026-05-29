import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * BullMQ worker host — empty skeleton (scaffold only).
 *
 * In Phase 0+ this process:
 *  - runs the Outbox relay (kernel §5.2) to publish domain events exactly-once,
 *  - hosts async event-bus handlers and scheduled batch jobs (period-close, MV refresh,
 *    connector polling), surfaced in platform.job-monitor.
 *
 * No queues/workers are registered yet.
 */
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

export const connection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });

// Reserved queue name; workers are registered per domain in later phases.
export const OUTBOX_QUEUE = 'erp.outbox';
export const outboxQueue = new Queue(OUTBOX_QUEUE, { connection });

async function bootstrap(): Promise<void> {
  console.warn('[worker] online (no queues registered yet) — connected to', REDIS_URL);
}

void bootstrap();
