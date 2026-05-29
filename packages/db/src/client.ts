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
