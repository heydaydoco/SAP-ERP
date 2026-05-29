import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

/**
 * Example Testcontainers integration test (root CLAUDE.md §5.4).
 *
 * Spins up a throwaway PostgreSQL 16, proves we can connect and run SQL, then tears it down.
 * Real FI-posting integration tests (balanced journals, period locking, idempotency) follow this
 * shape in Phase 2. Set SKIP_TESTCONTAINERS=1 to skip where Docker is unavailable (e.g. web CI).
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';

describe.skipIf(!dockerAvailable)('Postgres via Testcontainers', () => {
  let container: StartedPostgreSqlContainer;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    sql = postgres(container.getConnectionUri());
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  it('connects and runs a query', async () => {
    const rows = await sql<{ n: number }[]>`select 1 as n`;
    expect(rows[0]?.n).toBe(1);
  });

  it('can create a table with the mandated audit-4 columns', async () => {
    await sql`
      create table demo_doc (
        id          uuid primary key default gen_random_uuid(),
        amount      numeric(18,2) not null,
        created_at  timestamptz not null default now(),
        created_by  text not null,
        updated_at  timestamptz not null default now(),
        updated_by  text not null
      )
    `;
    await sql`insert into demo_doc (amount, created_by, updated_by) values (${'100.00'}, 'tester', 'tester')`;
    const rows = await sql<{ amount: string }[]>`select amount from demo_doc`;
    // NUMERIC comes back as a string — money is never a JS float.
    expect(rows[0]?.amount).toBe('100.00');
  });
});
