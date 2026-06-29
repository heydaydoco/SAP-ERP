import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { OrgStructureService } from '../../src/domains/platform/org-structure/org-structure.service.js';
import { NumberingService } from '../../src/domains/platform/numbering/numbering.service.js';
import { DocFlowService } from '../../src/domains/platform/doc-flow/doc-flow.service.js';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import { CarrierBookingService } from '../../src/domains/logistics-4pl/carrier-booking/carrier-booking.service.js';
import {
  DOC_FLOW_TYPE_CARRIER_BOOKING,
  DOC_FLOW_TYPE_SHIPMENT,
  REL_BOOKS,
} from '../../src/domains/logistics-4pl/logistics-4pl.constants.js';

/**
 * Carrier booking (운송수배) integration over a real PostgreSQL 16 (Testcontainers, §5.4). A NON-POSTING
 * reservation registered against a shipment with a carrier (선사) BP — the FIRST consumer of the `carrier` BP
 * role (0025). Proves end-to-end: docNo CB-NNNNNN, the OPEN booking with its cut-offs (all nullable), the
 * `BOOKS` doc_flow edge onto the shipment, the carrier-role guard (a BP with no carrier role → 400), the
 * read-only shipment guards (unknown → 404, foreign company → 400), one shipment holding multiple bookings,
 * and — crucially — that NO journal / journal_line is written AND the shipment's own status is never touched.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('logistics-4pl 운송수배 (carrier booking) (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let bookings: CarrierBookingService;
  let partners: BusinessPartnerService;
  let companyCodeId: string;
  let otherCompanyCodeId: string;
  let carrierBpId: string;
  let noRoleBpId: string;
  let shipSeq = 0;

  const journalCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalEntry);
    return row?.c ?? 0;
  };
  const journalLineCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalLine);
    return row?.c ?? 0;
  };

  /** Insert a PLANNED shipment header directly under `company` — shipment creation is tested elsewhere. */
  const makeShipment = async (company: string): Promise<string> => {
    shipSeq += 1;
    const [row] = await db
      .insert(schema.shipment)
      .values({
        docType: 'SH',
        docNo: `SH-${String(shipSeq).padStart(6, '0')}`,
        status: 'PLANNED',
        companyCodeId: company,
        transportMode: 'SEA',
        createdBy: 'test',
        updatedBy: 'test',
      })
      .returning({ id: schema.shipment.id });
    return row!.id;
  };

  const edgesOf = async (bookingId: string) =>
    db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_CARRIER_BOOKING),
          eq(schema.docFlow.sourceId, bookingId),
        ),
      );

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 5 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    const org = new OrgStructureService(db);
    const numbering = new NumberingService(db);
    const docFlow = new DocFlowService(db);
    partners = new BusinessPartnerService(db);
    bookings = new CarrierBookingService(db, numbering, docFlow, partners);

    const company = await org.createCompanyCode({
      code: '1000',
      name: 'Heyday Trading',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    const other = await org.createCompanyCode({
      code: '2000',
      name: 'Other Co',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    companyCodeId = company.id;
    otherCompanyCodeId = other.id;

    await numbering.defineRange({ object: 'logistics.carrier_booking', prefix: 'CB-', padding: 6 });

    // A carrier-role BP (선사) and a BP with NO carrier role (the negative-path subject).
    const carrierBp = await partners.createBp({
      code: 'CARR-OCEAN',
      name: 'Ocean Line Co.',
      bpType: 'ORGANIZATION',
    });
    carrierBpId = carrierBp.id;
    await partners.addCarrierRole(carrierBpId, { scac: 'MAEU' }, 'test');
    const noRole = await partners.createBp({
      code: 'BP-NOROLE',
      name: 'No Carrier Role Co.',
      bpType: 'ORGANIZATION',
    });
    noRoleBpId = noRole.id;
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — full create (all cut-offs): CB- doc no, OPEN, BOOKS edge, no journal, shipment stays PLANNED.
  it('creates a booking (CB-, OPEN, cut-offs, BOOKS edge, no journal, shipment unchanged)', async () => {
    const shipmentId = await makeShipment(companyCodeId);
    const jBefore = await journalCount();
    const jlBefore = await journalLineCount();

    const created = await bookings.create(
      {
        companyCodeId,
        shipmentId,
        carrierBpId,
        bookingNo: 'MAEU-BK-001',
        cargoCutoff: '2026-03-10T08:00:00Z',
        docCutoff: '2026-03-09T17:00:00Z',
        vgmCutoff: '2026-03-09T12:00:00Z',
        reference: 'JOB-001',
      },
      'tester',
    );

    expect(created.docNo).toMatch(/^CB-\d{6}$/);
    expect(created.status).toBe('OPEN');

    // NON-POSTING.
    expect(await journalCount()).toBe(jBefore);
    expect(await journalLineCount()).toBe(jlBefore);

    const full = await bookings.getCarrierBooking(created.carrierBookingId);
    expect(full).toMatchObject({
      status: 'OPEN',
      shipmentId,
      carrierBpId,
      bookingNo: 'MAEU-BK-001',
      reference: 'JOB-001',
    });
    expect(full.cargoCutoff).not.toBeNull();
    expect(full.docCutoff).not.toBeNull();
    expect(full.vgmCutoff).not.toBeNull();

    // Physical lineage: exactly one BOOKS → the shipment.
    const books = (await edgesOf(created.carrierBookingId)).filter((e) => e.relType === REL_BOOKS);
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ targetType: DOC_FLOW_TYPE_SHIPMENT, targetId: shipmentId });

    // The booking NEVER touches the shipment status machine — it is still PLANNED.
    const [ship] = await db
      .select({ status: schema.shipment.status })
      .from(schema.shipment)
      .where(eq(schema.shipment.id, shipmentId));
    expect(ship!.status).toBe('PLANNED');
  });

  // 2 — cut-offs are optional (carrier not yet confirmed): a booking with none is valid.
  it('creates a booking with no cut-offs (all null)', async () => {
    const shipmentId = await makeShipment(companyCodeId);
    const created = await bookings.create(
      { companyCodeId, shipmentId, carrierBpId, bookingNo: 'MAEU-BK-EMPTY' },
      'tester',
    );
    const full = await bookings.getCarrierBooking(created.carrierBookingId);
    expect(full).toMatchObject({ cargoCutoff: null, docCutoff: null, vgmCutoff: null });
  });

  // 3 — one shipment may hold multiple bookings (re-booking) — no (shipment_id) unique.
  it('allows multiple bookings on one shipment', async () => {
    const shipmentId = await makeShipment(companyCodeId);
    await bookings.create({ companyCodeId, shipmentId, carrierBpId, bookingNo: 'BK-A' }, 'tester');
    await bookings.create({ companyCodeId, shipmentId, carrierBpId, bookingNo: 'BK-B' }, 'tester');
    const list = await bookings.listForShipment(shipmentId);
    expect(list).toHaveLength(2);
    expect(list.map((b) => b.bookingNo).sort()).toEqual(['BK-A', 'BK-B']);
  });

  // 4 — the carrier guard: a BP with no carrier role → 400; an unknown BP → 404 (getBp).
  it('rejects a BP with no carrier role (400) and an unknown carrier BP (404)', async () => {
    const shipmentId = await makeShipment(companyCodeId);
    await expect(
      bookings.create({ companyCodeId, shipmentId, carrierBpId: noRoleBpId, bookingNo: 'X' }, 'tester'),
    ).rejects.toThrow(/has no carrier role/);
    await expect(
      bookings.create({ companyCodeId, shipmentId, carrierBpId: randomUUID(), bookingNo: 'X' }, 'tester'),
    ).rejects.toThrow(/business partner .* not found/);
  });

  // 5 — read-only shipment guards: unknown shipment (404), foreign-company shipment (400).
  it('rejects an unknown shipment (404) and a foreign-company shipment (400)', async () => {
    await expect(
      bookings.create(
        { companyCodeId, shipmentId: randomUUID(), carrierBpId, bookingNo: 'X' },
        'tester',
      ),
    ).rejects.toThrow(/shipment .* not found/);

    const foreign = await makeShipment(otherCompanyCodeId);
    await expect(
      bookings.create({ companyCodeId, shipmentId: foreign, carrierBpId, bookingNo: 'X' }, 'tester'),
    ).rejects.toThrow(/belongs to another company code/);
  });

  // 6 — non-posting invariant: the whole slice writes no journal and no journal_line.
  it('writes no journal or journal_line across the whole slice', async () => {
    expect(await journalCount()).toBe(0);
    expect(await journalLineCount()).toBe(0);
  });
});
