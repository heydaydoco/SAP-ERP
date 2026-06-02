import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { schema, type Database } from '@erp/db';
import { OrgStructureService } from '../../src/domains/platform/org-structure/org-structure.service.js';
import { FiscalPeriodService } from '../../src/domains/platform/admin-config/fiscal-period.service.js';
import { AccountDeterminationService } from '../../src/domains/platform/admin-config/account-determination.service.js';

/**
 * Admin-config integration over a real PostgreSQL 16 (Testcontainers): runs the committed
 * migrations, then proves fiscal-period locking (open → close blocks posting; no period rejects)
 * and account determination (most-specific rule wins; unknown key throws). Set SKIP_TESTCONTAINERS=1
 * to skip where Docker is absent.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('platform admin-config (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let org: OrgStructureService;
  let fiscal: FiscalPeriodService;
  let accounts: AccountDeterminationService;
  let companyCodeId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    org = new OrgStructureService(db);
    fiscal = new FiscalPeriodService(db);
    accounts = new AccountDeterminationService(db);

    const company = await org.createCompanyCode({
      code: '1000',
      name: 'Heyday Trading',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    companyCodeId = company.id;
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  it('generates a calendar fiscal year of 12 open periods', async () => {
    const yearId = await fiscal.generateYear(companyCodeId, 2026);
    const periods = await fiscal.listPeriods(yearId);
    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({
      periodNo: 1,
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
    expect(periods[1]).toMatchObject({ periodNo: 2, endDate: '2026-02-28' });
    expect(periods[11]).toMatchObject({ periodNo: 12, endDate: '2026-12-31' });
    expect(periods.every((p) => p.status === 'OPEN')).toBe(true);

    expect(await fiscal.isPeriodOpen(companyCodeId, '2026-03-15')).toBe(true);
    await expect(fiscal.assertPeriodOpen(companyCodeId, '2026-03-15')).resolves.toBeUndefined();
  });

  it('blocks postings into a closed period and rejects dates with no period', async () => {
    const yearId = await fiscal.generateYear(companyCodeId, 2026); // idempotent
    const periods = await fiscal.listPeriods(yearId);
    const march = periods.find((p) => p.periodNo === 3)!;

    await fiscal.closePeriod(march.id);
    expect(await fiscal.isPeriodOpen(companyCodeId, '2026-03-15')).toBe(false);
    await expect(fiscal.assertPeriodOpen(companyCodeId, '2026-03-15')).rejects.toThrow(/closed/);

    // A different (still open) period is unaffected.
    await expect(fiscal.assertPeriodOpen(companyCodeId, '2026-04-15')).resolves.toBeUndefined();

    // No period defined for 2099 → rejected.
    await expect(fiscal.assertPeriodOpen(companyCodeId, '2099-01-01')).rejects.toThrow(
      /no fiscal period/,
    );
  });

  it('generateYear is idempotent (no duplicate periods)', async () => {
    const a = await fiscal.generateYear(companyCodeId, 2027);
    const b = await fiscal.generateYear(companyCodeId, 2027);
    expect(a).toBe(b);
    expect(await fiscal.listPeriods(a)).toHaveLength(12);
  });

  it('resolves account determination, preferring the most specific rule', async () => {
    await accounts.defineRule({
      chartOfAccounts: 'KR01',
      transactionKey: 'SALES_REVENUE',
      glAccount: '4000',
    });
    await accounts.defineRule({ chartOfAccounts: 'KR01', transactionKey: 'AR', glAccount: '1100' });
    // company-specific override for AR under company code 1000
    await accounts.defineRule({
      chartOfAccounts: 'KR01',
      transactionKey: 'AR',
      companyCode: '1000',
      glAccount: '1100C',
    });

    expect(
      await accounts.resolve({ chartOfAccounts: 'KR01', transactionKey: 'SALES_REVENUE' }),
    ).toBe('4000');
    // most specific wins for company 1000
    expect(
      await accounts.resolve({
        chartOfAccounts: 'KR01',
        transactionKey: 'AR',
        companyCode: '1000',
      }),
    ).toBe('1100C');
    // falls back to the wildcard rule for a different company
    expect(
      await accounts.resolve({
        chartOfAccounts: 'KR01',
        transactionKey: 'AR',
        companyCode: '9999',
      }),
    ).toBe('1100');
  });

  it('defineRule upserts the GL account for an existing key', async () => {
    await accounts.defineRule({
      chartOfAccounts: 'KR01',
      transactionKey: 'OUTPUT_VAT',
      glAccount: '2550',
    });
    await accounts.defineRule({
      chartOfAccounts: 'KR01',
      transactionKey: 'OUTPUT_VAT',
      glAccount: '2551',
    });
    expect(await accounts.resolve({ chartOfAccounts: 'KR01', transactionKey: 'OUTPUT_VAT' })).toBe(
      '2551',
    );
    expect(await accounts.count('KR01')).toBeGreaterThanOrEqual(3);
  });

  it('throws when no account determination rule matches', async () => {
    await expect(
      accounts.resolve({ chartOfAccounts: 'KR01', transactionKey: 'NONEXISTENT' }),
    ).rejects.toThrow(/no account determination rule/);
  });
});
