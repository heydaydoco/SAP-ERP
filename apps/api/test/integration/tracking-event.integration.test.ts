import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { OrgStructureService } from '../../src/domains/platform/org-structure/org-structure.service.js';
import { TrackingEventService } from '../../src/domains/logistics-4pl/tracking-event/tracking-event.service.js';

/**
 * Tracking event (화물추적) integration over a real PostgreSQL 16 (Testcontainers, §5.4). The slice is a
 * NON-POSTING, header-less observation log hung off a shipment — INDEPENDENT of the shipment status machine.
 * This proves end-to-end: events append with intake-order `line_no`, `listForShipment` returns them in
 * `event_time` chronological order (decoupled from intake order), the SAME `event_type` may recur (no unique),
 * the read-only shipment guards (unknown → 404, foreign company → 400), and that NO journal / journal_line is
 * EVER written (and the shipment's own status is never touched).
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('logistics-4pl 화물추적 (tracking event) (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let tracking: TrackingEventService;
  let companyCodeId: string;
  let otherCompanyCodeId: string;
  let shipSeq = 0;

  const journalCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalEntry);
    return row?.c ?? 0;
  };
  const journalLineCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalLine);
    return row?.c ?? 0;
  };

  /** Insert a shipment header directly under `company` (a BOOKED 선적) — shipment creation is tested elsewhere. */
  const makeShipment = async (company: string): Promise<string> => {
    shipSeq += 1;
    const [row] = await db
      .insert(schema.shipment)
      .values({
        docType: 'SH',
        docNo: `SH-${String(shipSeq).padStart(6, '0')}`,
        status: 'BOOKED',
        companyCodeId: company,
        transportMode: 'SEA',
        createdBy: 'test',
        updatedBy: 'test',
      })
      .returning({ id: schema.shipment.id, status: schema.shipment.status });
    return row!.id;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 5 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    const org = new OrgStructureService(db);
    tracking = new TrackingEventService(db);

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
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — events appended out of chronological order; the timeline read is event_time asc, line_no is intake
  //     order (the two are decoupled). No journal. The shipment status is never touched.
  it('returns a shipment timeline in event_time order, decoupled from intake (line_no) order', async () => {
    const shipmentId = await makeShipment(companyCodeId);
    const jBefore = await journalCount();
    const jlBefore = await journalLineCount();

    // Insert NON-chronologically (DEPARTED first, GATE_IN earliest-in-time but second-in-intake, …).
    const e1 = await tracking.createEvent(
      { companyCodeId, shipmentId, eventType: 'DEPARTED', eventTime: '2026-03-11T00:00:00Z', location: 'KRPUS' },
      'tester',
    );
    const e2 = await tracking.createEvent(
      { companyCodeId, shipmentId, eventType: 'GATE_IN', eventTime: '2026-03-10T08:00:00Z', description: 'gate-in at terminal' },
      'tester',
    );
    await tracking.createEvent(
      { companyCodeId, shipmentId, eventType: 'ARRIVED', eventTime: '2026-03-15T00:00:00Z', location: 'USLAX' },
      'tester',
    );
    await tracking.createEvent(
      { companyCodeId, shipmentId, eventType: 'LOADED', eventTime: '2026-03-10T20:00:00Z' },
      'tester',
    );

    // Intake order assigns line_no 1..4 in insert order.
    expect(e1).toMatchObject({ lineNo: 1, eventType: 'DEPARTED' });
    expect(e2).toMatchObject({ lineNo: 2, eventType: 'GATE_IN' });

    const timeline = await tracking.listForShipment(shipmentId);
    // Chronological by event_time: GATE_IN (03-10 08) → LOADED (03-10 20) → DEPARTED (03-11) → ARRIVED (03-15).
    expect(timeline.map((e) => e.eventType)).toEqual(['GATE_IN', 'LOADED', 'DEPARTED', 'ARRIVED']);
    // The first timeline entry (GATE_IN) was the SECOND intake → line_no 2, proving line_no ≠ timeline order.
    expect(timeline[0]).toMatchObject({ eventType: 'GATE_IN', lineNo: 2, description: 'gate-in at terminal' });
    expect(timeline[3]).toMatchObject({ eventType: 'ARRIVED', lineNo: 3, location: 'USLAX' });

    // Pure observation log → NOTHING posts to FI, and the shipment status is unchanged (BOOKED).
    expect(await journalCount()).toBe(jBefore);
    expect(await journalLineCount()).toBe(jlBefore);
    const [ship] = await db
      .select({ status: schema.shipment.status })
      .from(schema.shipment)
      .where(sql`${schema.shipment.id} = ${shipmentId}`);
    expect(ship!.status).toBe('BOOKED');
  });

  // 2 — the same event_type may legitimately recur (e.g. IN_TRANSIT per 환적) — no (shipment, type) unique.
  it('allows the same event_type to recur on one shipment', async () => {
    const shipmentId = await makeShipment(companyCodeId);
    await tracking.createEvent(
      { companyCodeId, shipmentId, eventType: 'IN_TRANSIT', eventTime: '2026-03-12T00:00:00Z', location: 'Transshipment SGSIN' },
      'tester',
    );
    await tracking.createEvent(
      { companyCodeId, shipmentId, eventType: 'IN_TRANSIT', eventTime: '2026-03-13T00:00:00Z', location: 'Transshipment HKHKG' },
      'tester',
    );

    const timeline = await tracking.listForShipment(shipmentId);
    expect(timeline).toHaveLength(2);
    expect(timeline.filter((e) => e.eventType === 'IN_TRANSIT')).toHaveLength(2);
    expect(timeline.map((e) => e.lineNo)).toEqual([1, 2]);
  });

  // 3 — read-only shipment guards: unknown shipment (404), foreign-company shipment (400).
  it('rejects an unknown shipment (404) and a foreign-company shipment (400)', async () => {
    await expect(
      tracking.createEvent(
        { companyCodeId, shipmentId: randomUUID(), eventType: 'GATE_IN', eventTime: '2026-03-10T00:00:00Z' },
        'tester',
      ),
    ).rejects.toThrow(/shipment .* not found/);

    const foreign = await makeShipment(otherCompanyCodeId);
    await expect(
      tracking.createEvent(
        { companyCodeId, shipmentId: foreign, eventType: 'GATE_IN', eventTime: '2026-03-10T00:00:00Z' },
        'tester',
      ),
    ).rejects.toThrow(/belongs to another company code/);
  });

  // 4 — non-posting invariant: the whole slice writes no journal and no journal_line.
  it('writes no journal or journal_line across the whole slice', async () => {
    expect(await journalCount()).toBe(0);
    expect(await journalLineCount()).toBe(0);
  });
});
