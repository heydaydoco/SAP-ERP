import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import { createCarrierRoleSchema } from '../../src/domains/master-data/business-partner/business-partner.dto.js';

/**
 * Business-partner CARRIER role (운송인 — 선사/항공사) integration over a real PostgreSQL 16 (Testcontainers,
 * §5.4). The carrier role is a NON-POSTING 1:1 extension (like vendor/customer) but with NO reconciliation
 * account — so this proves end-to-end: a carrier role attaches with its mode-split identity codes (SCAC 육해상 /
 * IATA 항공, each independently nullable), `getBp` surfaces it additively alongside customer/vendor, the role is
 * unique per BP (409 on a second), an unknown BP 404s, and — crucially — the role is created **without any GL
 * account in the database** (no `assertReconAccount`), in direct contrast to the vendor role which 404s on a
 * missing recon account. NO journal / journal_line is ever written.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('master-data business-partner carrier role (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let partners: BusinessPartnerService;
  let bpSeq = 0;

  const journalCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalEntry);
    return row?.c ?? 0;
  };
  const journalLineCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalLine);
    return row?.c ?? 0;
  };
  const glAccountCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.glAccount);
    return row?.c ?? 0;
  };

  /** A fresh ORGANIZATION business partner; returns its id. */
  const newBp = async (): Promise<string> => {
    bpSeq += 1;
    const bp = await partners.createBp({
      code: `CARR-${bpSeq}`,
      name: `Carrier ${bpSeq}`,
      bpType: 'ORGANIZATION',
    });
    return bp.id;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 5 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });
    // NOTE: deliberately NO gl_account rows are seeded — the carrier role must not need one.
    partners = new BusinessPartnerService(db);
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — SCAC-only carrier (해상 선사): role attaches, getBp surfaces it (iata null, customer/vendor null), no journal.
  it('attaches a SCAC-only carrier role and surfaces it on getBp (no journal)', async () => {
    const bpId = await newBp();
    const jBefore = await journalCount();
    const jlBefore = await journalLineCount();

    const role = await partners.addCarrierRole(bpId, { scac: 'MAEU' }, 'tester');
    expect(role).toMatchObject({ bpId, scac: 'MAEU', iataCode: null });

    const full = await partners.getBp(bpId);
    expect(full.carrier).toMatchObject({ scac: 'MAEU', iataCode: null });
    expect(full.customer).toBeNull();
    expect(full.vendor).toBeNull();

    // NON-POSTING master write.
    expect(await journalCount()).toBe(jBefore);
    expect(await journalLineCount()).toBe(jlBefore);
  });

  // 2 — IATA-only carrier (항공사) and a both-codes carrier both attach.
  it('attaches IATA-only and SCAC+IATA carrier roles', async () => {
    const air = await newBp();
    const roleAir = await partners.addCarrierRole(air, { iataCode: 'KE' }, 'tester');
    expect(roleAir).toMatchObject({ scac: null, iataCode: 'KE' });

    const both = await newBp();
    const roleBoth = await partners.addCarrierRole(both, { scac: 'HLCU', iataCode: '9W' }, 'tester');
    expect(roleBoth).toMatchObject({ scac: 'HLCU', iataCode: '9W' });
  });

  // 3 — an empty payload is valid: the role itself is the flag (codes keyed in later).
  it('attaches a carrier role with no codes (role is the flag)', async () => {
    const bpId = await newBp();
    const role = await partners.addCarrierRole(bpId, {}, 'tester');
    expect(role).toMatchObject({ bpId, scac: null, iataCode: null });
    const full = await partners.getBp(bpId);
    expect(full.carrier).not.toBeNull();
  });

  // 4 — a second carrier role on the same BP is rejected (1:1, 409); an unknown BP is 404.
  it('rejects a duplicate carrier role (409) and an unknown BP (404)', async () => {
    const bpId = await newBp();
    await partners.addCarrierRole(bpId, { scac: 'ONEY' }, 'tester');
    await expect(partners.addCarrierRole(bpId, { scac: 'COSU' }, 'tester')).rejects.toThrow(
      /already has a carrier role/,
    );
    await expect(
      partners.addCarrierRole(randomUUID(), { scac: 'COSU' }, 'tester'),
    ).rejects.toThrow(/business partner .* not found/);
  });

  // 5 — ★ the carrier role needs NO reconciliation account: it is created with ZERO gl_account rows present,
  //     whereas a vendor role on the same setup 404s on its (missing) recon account. Proves no assertReconAccount.
  it('creates a carrier role with no GL accounts present, where a vendor role would fail', async () => {
    expect(await glAccountCount()).toBe(0); // no recon accounts exist anywhere

    const carrierBp = await newBp();
    const role = await partners.addCarrierRole(carrierBp, { scac: 'YMLU' }, 'tester');
    expect(role).toMatchObject({ scac: 'YMLU' }); // succeeded with no GL master

    // Contrast: a vendor role validates its recon account against the (empty) GL master → 404.
    const vendorBp = await newBp();
    await expect(
      partners.addVendorRole(vendorBp, { apReconAccount: '2100', purchasingBlock: false }, 'tester'),
    ).rejects.toThrow(/gl account 2100 not found/);
  });

  // 6 — non-posting invariant: the whole slice writes no journal and no journal_line.
  it('writes no journal or journal_line across the whole slice', async () => {
    expect(await journalCount()).toBe(0);
    expect(await journalLineCount()).toBe(0);
  });
});

/** DTO format validation (pure Zod — no DB). SCAC/IATA shapes are enforced at the edge, not by a DB CHECK. */
describe('createCarrierRoleSchema (DTO validation)', () => {
  it('accepts valid SCAC / IATA codes (and an empty payload)', () => {
    expect(createCarrierRoleSchema.safeParse({ scac: 'MAEU' }).success).toBe(true);
    expect(createCarrierRoleSchema.safeParse({ scac: 'KL' }).success).toBe(true); // 2 letters
    expect(createCarrierRoleSchema.safeParse({ iataCode: 'KE' }).success).toBe(true);
    expect(createCarrierRoleSchema.safeParse({ iataCode: '9W' }).success).toBe(true); // alphanumeric
    expect(createCarrierRoleSchema.safeParse({ scac: 'HLCU', iataCode: 'OZ' }).success).toBe(true);
    expect(createCarrierRoleSchema.safeParse({}).success).toBe(true); // role is the flag
  });

  it('rejects malformed SCAC (lowercase / 5 chars / 1 char) and IATA (lowercase / 4 chars)', () => {
    expect(createCarrierRoleSchema.safeParse({ scac: 'maeu' }).success).toBe(false);
    expect(createCarrierRoleSchema.safeParse({ scac: 'ABCDE' }).success).toBe(false);
    expect(createCarrierRoleSchema.safeParse({ scac: 'A' }).success).toBe(false);
    expect(createCarrierRoleSchema.safeParse({ scac: '' }).success).toBe(false);
    expect(createCarrierRoleSchema.safeParse({ iataCode: 'ke' }).success).toBe(false);
    expect(createCarrierRoleSchema.safeParse({ iataCode: 'ABCD' }).success).toBe(false);
  });
});
