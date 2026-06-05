import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

/**
 * Shared Drizzle client. The connection string comes from DATABASE_URL.
 * apps/api and apps/worker import this; tests use Testcontainers with their own URL.
 */
export function createDb(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  const queryClient = postgres(connectionString);
  return drizzle(queryClient, { schema, casing: 'snake_case' });
}

export type Database = ReturnType<typeof createDb>;

/** A live transaction handle from `db.transaction(cb)` — same query interface as the client. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Either the shared client or an active transaction. Platform services that domains call from
 * inside a posting transaction (numbering, outbox, doc-flow) accept this as an optional last
 * parameter so their writes commit atomically with the caller's (root CLAUDE.md §5.2).
 */
export type DbExecutor = Database | Transaction;
