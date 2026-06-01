import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { Money } from '@erp/kernel';

/**
 * Example Testcontainers integration test (root CLAUDE.md §5.4).
 *
 * Spins up a throwaway PostgreSQL 16, proves we can connect and that money persists correctly as
 * currency-aware `NUMERIC(18,4)` (KRW with 0 decimals, USD with 2), round-tripping through the
 * kernel `Money`. Real FI-posting integration tests follow this shape in Phase 2.
 * Set SKIP_TESTCONTAINERS=1 to skip where Docker is unavailable (e.g. web CI).
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

  it('stores money as currency-aware NUMERIC(18,4) with the audit-4 columns', async () => {
    await sql`
      create table demo_doc (
        id          uuid primary key default gen_random_uuid(),
        amount      numeric(18,4) not null,
        currency    char(3) not null,
        created_at  timestamptz not null default now(),
        created_by  text not null,
        updated_at  timestamptz not null default now(),
        updated_by  text not null
      )
    `;

    const krw = Money.of('1500', 'KRW'); // 0 decimals
    const usd = Money.of('1.50', 'USD'); // 2 decimals
    for (const m of [krw, usd]) {
      await sql`insert into demo_doc (amount, currency, created_by, updated_by)
                values (${m.toNumeric()}, ${m.currency}, 'tester', 'tester')`;
    }

    const rows = await sql<{ amount: string; currency: string }[]>`
      select amount, currency from demo_doc order by currency`;

    // NUMERIC comes back as a string (never a JS float); Money.fromNumeric reconstructs it exactly.
    const byCur = Object.fromEntries(rows.map((r) => [r.currency, r.amount]));
    expect(byCur['KRW']).toBe('1500.0000');
    expect(byCur['USD']).toBe('1.5000');
    expect(Money.fromNumeric(byCur['KRW']!, 'KRW').equals(krw)).toBe(true);
    expect(Money.fromNumeric(byCur['USD']!, 'USD').equals(usd)).toBe(true);
  });
});
