import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { schema, type Database } from '@erp/db';
import { OrgStructureService } from '../../src/domains/platform/org-structure/org-structure.service.js';

/**
 * Enterprise-structure integration over a real PostgreSQL 16 (Testcontainers): runs the committed
 * migrations, then proves the company → plant → storage-location hierarchy, code uniqueness within
 * a parent, and parent-existence guards. Set SKIP_TESTCONTAINERS=1 to skip where Docker is absent.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('platform org-structure (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let org: OrgStructureService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    db = drizzle(client, {
      schema,
      casing: 'snake_case',
    }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    org = new OrgStructureService(db);
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  it('builds the company → plant → storage location hierarchy', async () => {
    const company = await org.createCompanyCode({
      code: '1000',
      name: 'Heyday Trading',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    expect(company.id).toBeTruthy();
    expect(company.currency).toBe('KRW');
    expect(company.createdBy).toBe('system');

    const plant = await org.createPlant({
      code: '1010',
      name: 'Seoul Plant',
      companyCodeId: company.id,
      country: 'KR',
      city: 'Seoul',
    });
    expect(plant.companyCodeId).toBe(company.id);

    const sloc = await org.createStorageLocation({
      code: '101A',
      name: 'Main Warehouse',
      plantId: plant.id,
    });
    expect(sloc.plantId).toBe(plant.id);

    const plants = await org.listPlants(company.id, 20, 0);
    expect(plants.map((p) => p.code)).toEqual(['1010']);
    const slocs = await org.listStorageLocations(plant.id, 20, 0);
    expect(slocs.map((s) => s.code)).toEqual(['101A']);
    expect(await org.countStorageLocations(plant.id)).toBe(1);
  });

  it('rejects a duplicate plant code within the same company', async () => {
    const company = await org.createCompanyCode({
      code: '2000',
      name: 'Dup Co',
      currency: 'USD',
      country: 'US',
    });
    await org.createPlant({
      code: 'P1',
      name: 'Plant 1',
      companyCodeId: company.id,
    });
    await expect(
      org.createPlant({
        code: 'P1',
        name: 'Plant 1 again',
        companyCodeId: company.id,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('allows the same plant code under a different company', async () => {
    const a = await org.createCompanyCode({
      code: '3000',
      name: 'Co A',
      currency: 'EUR',
      country: 'DE',
    });
    const b = await org.createCompanyCode({
      code: '3100',
      name: 'Co B',
      currency: 'EUR',
      country: 'DE',
    });
    const pa = await org.createPlant({
      code: 'SHARED',
      name: 'A plant',
      companyCodeId: a.id,
    });
    const pb = await org.createPlant({
      code: 'SHARED',
      name: 'B plant',
      companyCodeId: b.id,
    });
    expect(pa.id).not.toBe(pb.id);
  });

  it('rejects a plant under a non-existent company', async () => {
    await expect(
      org.createPlant({
        code: 'X1',
        name: 'Orphan',
        companyCodeId: '00000000-0000-0000-0000-000000000000',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('creates sales and purchasing orgs and ensure* is idempotent', async () => {
    const company = await org.createCompanyCode({
      code: '4000',
      name: 'Org Co',
      currency: 'KRW',
      country: 'KR',
    });
    const sales = await org.createSalesOrg({
      code: 'S1',
      name: 'Domestic Sales',
      companyCodeId: company.id,
      currency: 'KRW',
    });
    expect(sales.currency).toBe('KRW');
    await org.createPurchasingOrg({
      code: 'P1',
      name: 'Central Purchasing',
      companyCodeId: company.id,
    });

    // ensure* returns the existing id without creating a duplicate.
    const firstId = await org.ensureSalesOrg({
      code: 'S1',
      name: 'Domestic Sales',
      companyCodeId: company.id,
    });
    const secondId = await org.ensureSalesOrg({
      code: 'S1',
      name: 'Domestic Sales',
      companyCodeId: company.id,
    });
    expect(firstId).toBe(sales.id);
    expect(secondId).toBe(sales.id);
    expect(await org.countSalesOrgs(company.id)).toBe(1);
  });
});
