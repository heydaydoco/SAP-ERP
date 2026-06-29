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
import { ShippingDocumentService } from '../../src/domains/logistics-4pl/shipping-document/shipping-document.service.js';
import {
  DOC_FLOW_TYPE_SHIPMENT,
  DOC_FLOW_TYPE_SHIPPING_DOCUMENT,
  REL_DOCUMENTS,
} from '../../src/domains/logistics-4pl/logistics-4pl.constants.js';

/**
 * Shipping document set (선적 서류세트) integration over a real PostgreSQL 16 (Testcontainers, §5.4). The slice
 * is a NON-POSTING physical record (B/L·CI·PL document numbers bundled against one shipment), so this proves
 * the non-posting document end-to-end: docNo SD-NNNNNN, the OPEN set + N document lines, the `DOCUMENTS`
 * doc_flow edge onto the shipment, `addDocument` appending a line at the next line_no, the (docKind, docNumber)
 * duplicate guards (in-payload → 400, cross-call → 409), the read-only shipment company check, and that NO
 * journal / journal_line is EVER written by the whole slice.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)(
  'logistics-4pl 선적 서류세트 (shipping document set) (integration)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: ReturnType<typeof postgres>;
    let db: Database;
    let shippingDocuments: ShippingDocumentService;
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
        .returning({ id: schema.shipment.id });
      return row!.id;
    };

    /** The doc_flow edges out of a shipping document set (DOCUMENTS → shipment). */
    const edgesOf = async (setId: string) =>
      db
        .select()
        .from(schema.docFlow)
        .where(
          and(
            eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_SHIPPING_DOCUMENT),
            eq(schema.docFlow.sourceId, setId),
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
      shippingDocuments = new ShippingDocumentService(db, numbering, docFlow);

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

      await numbering.defineRange({
        object: 'logistics.shipping_document',
        prefix: 'SD-',
        padding: 6,
      });
    }, 120_000);

    afterAll(async () => {
      await client?.end({ timeout: 5 });
      await container?.stop();
    });

    // 1 — full create: SD- doc no, OPEN, 3 lines (BL+CI+PL), one DOCUMENTS edge onto the shipment, no journal.
    it('creates a document set (SD-, OPEN, 3 lines, DOCUMENTS edge, no journal)', async () => {
      const shipmentId = await makeShipment(companyCodeId);
      const jBefore = await journalCount();
      const jlBefore = await journalLineCount();

      const created = await shippingDocuments.create(
        {
          companyCodeId,
          shipmentId,
          reference: 'SET-001',
          items: [
            { docKind: 'BL', docNumber: 'HMMU-MBL-001', issueDate: '2026-03-10', issuerText: 'HMM' },
            { docKind: 'CI', docNumber: 'CI-2026-001', issueDate: '2026-03-09' },
            { docKind: 'PL', docNumber: 'PL-2026-001' },
          ],
        },
        'tester',
      );

      expect(created.docNo).toMatch(/^SD-\d{6}$/);
      expect(created.status).toBe('OPEN');

      // The set posts NOTHING to FI.
      expect(await journalCount()).toBe(jBefore);
      expect(await journalLineCount()).toBe(jlBefore);

      const full = await shippingDocuments.getShippingDocumentSet(created.shippingDocumentSetId);
      expect(full.status).toBe('OPEN');
      expect(full.reference).toBe('SET-001');
      expect(full.items).toHaveLength(3);
      expect(full.items.map((i) => i.lineNo)).toEqual([1, 2, 3]);
      expect(full.items[0]).toMatchObject({
        docKind: 'BL',
        docNumber: 'HMMU-MBL-001',
        issueDate: '2026-03-10',
        issuerText: 'HMM',
      });
      // A line registered before issue: 발행일 / 발행처 stay NULL.
      expect(full.items[2]).toMatchObject({
        docKind: 'PL',
        docNumber: 'PL-2026-001',
        issueDate: null,
        issuerText: null,
      });

      // Physical lineage: exactly one DOCUMENTS → the shipment.
      const docs = (await edgesOf(created.shippingDocumentSetId)).filter(
        (e) => e.relType === REL_DOCUMENTS,
      );
      expect(docs).toHaveLength(1);
      expect(docs[0]).toMatchObject({ targetType: DOC_FLOW_TYPE_SHIPMENT, targetId: shipmentId });
    });

    // 2 — empty set then addDocument: opens with 0 lines, appends a B/L at line_no 1, a CI at line_no 2.
    it('opens an empty set and appends documents via addDocument (line_no 1, then 2)', async () => {
      const shipmentId = await makeShipment(companyCodeId);
      const created = await shippingDocuments.create(
        { companyCodeId, shipmentId, items: [] },
        'tester',
      );
      let full = await shippingDocuments.getShippingDocumentSet(created.shippingDocumentSetId);
      expect(full.items).toHaveLength(0);

      const line = await shippingDocuments.addDocument(
        created.shippingDocumentSetId,
        { docKind: 'BL', docNumber: 'HBL-555', issuerText: 'Forwarder' },
        'tester',
      );
      expect(line).toMatchObject({ lineNo: 1, docKind: 'BL', docNumber: 'HBL-555' });

      full = await shippingDocuments.getShippingDocumentSet(created.shippingDocumentSetId);
      expect(full.items).toHaveLength(1);

      // A second, different document goes to line_no 2.
      const line2 = await shippingDocuments.addDocument(
        created.shippingDocumentSetId,
        { docKind: 'CI', docNumber: 'CI-999' },
        'tester',
      );
      expect(line2.lineNo).toBe(2);
    });

    // 3 — duplicate (docKind, docNumber) in the same set across calls → 409.
    it('rejects a duplicate (docKind, docNumber) in the same set (409)', async () => {
      const shipmentId = await makeShipment(companyCodeId);
      const created = await shippingDocuments.create(
        { companyCodeId, shipmentId, items: [{ docKind: 'BL', docNumber: 'DUP-1' }] },
        'tester',
      );
      await expect(
        shippingDocuments.addDocument(
          created.shippingDocumentSetId,
          { docKind: 'BL', docNumber: 'DUP-1' },
          'tester',
        ),
      ).rejects.toThrow(/already registered/);
    });

    // 4 — read-only guards: an unknown shipment (404) and a foreign-company shipment (400) are rejected.
    it('rejects an unknown shipment (404) and a foreign-company shipment (400)', async () => {
      await expect(
        shippingDocuments.create({ companyCodeId, shipmentId: randomUUID(), items: [] }, 'tester'),
      ).rejects.toThrow(/shipment .* not found/);

      const foreign = await makeShipment(otherCompanyCodeId);
      await expect(
        shippingDocuments.create({ companyCodeId, shipmentId: foreign, items: [] }, 'tester'),
      ).rejects.toThrow(/belongs to another company code/);
    });

    // 5 — in-payload duplicate (docKind, docNumber) within one create → 400.
    it('rejects a duplicate (docKind, docNumber) within one create payload (400)', async () => {
      const shipmentId = await makeShipment(companyCodeId);
      await expect(
        shippingDocuments.create(
          {
            companyCodeId,
            shipmentId,
            items: [
              { docKind: 'BL', docNumber: 'SAME' },
              { docKind: 'BL', docNumber: 'SAME' },
            ],
          },
          'tester',
        ),
      ).rejects.toThrow(/at most once/);
    });

    // 6 — non-posting invariant: the whole slice writes no journal and no journal_line.
    it('writes no journal or journal_line across the whole slice', async () => {
      expect(await journalCount()).toBe(0);
      expect(await journalLineCount()).toBe(0);
    });
  },
);
