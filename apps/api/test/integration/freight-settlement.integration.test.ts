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
import { FiscalPeriodService } from '../../src/domains/platform/admin-config/fiscal-period.service.js';
import { NumberingService } from '../../src/domains/platform/numbering/numbering.service.js';
import { OutboxService } from '../../src/domains/platform/outbox/outbox.service.js';
import { DocFlowService } from '../../src/domains/platform/doc-flow/doc-flow.service.js';
import { AccountDeterminationService } from '../../src/domains/platform/admin-config/account-determination.service.js';
import { GlAccountService } from '../../src/domains/master-data/gl-account/gl-account.service.js';
import { DbCurrencyRegistry } from '../../src/domains/master-data/currency/db-currency-registry.js';
import { CurrencyService } from '../../src/domains/master-data/currency/currency.service.js';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import { JournalService } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import { FreightSettlementService } from '../../src/domains/logistics-4pl/freight-settlement/freight-settlement.service.js';
import {
  DOC_FLOW_TYPE_FREIGHT_SETTLEMENT,
  DOC_FLOW_TYPE_SHIPMENT,
  REL_POSTS,
  REL_SETTLES,
} from '../../src/domains/logistics-4pl/logistics-4pl.constants.js';
import { DOC_FLOW_TYPE as DOC_FLOW_TYPE_JOURNAL } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';

/**
 * Freight settlement (운임 정산) integration over a real PostgreSQL 16 (Testcontainers, §5.4). The 4PL domain's
 * FIRST FI document: a forwarder freight invoice hung off a shipment raises an AP open item via ONE `KR`
 * journal (Dr 지급운임 / Cr 외상매입금, +forwarder partner — the journal IS the AP document, like landed-cost).
 * Proves end-to-end: docNo FR-NNNNNN, the two-line balanced KR journal, recon substitution from the forwarder
 * vendor role, the `SETTLES`/`POSTS` doc_flow edges, FX delegation to `JournalService.post` (header rate stamp +
 * both-currency tie-out, no FX_ROUNDING), idempotent replay, the read-only shipment guards, and that the KR
 * journal is subledger-owned (FI reverse refused via the POSTS edge).
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('logistics-4pl 운임 정산 (freight settlement) (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let journals: JournalService;
  let freight: FreightSettlementService;

  let companyCodeId: string;
  let otherCompanyCodeId: string;
  let forwarderBpId: string;
  let noRoleBpId: string;
  let shipSeq = 0;

  const journalCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalEntry);
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

  /** The doc_flow edges out of a freight settlement (SETTLES → shipment, POSTS → journal). */
  const edgesOf = async (freightSettlementId: string) =>
    db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_FREIGHT_SETTLEMENT),
          eq(schema.docFlow.sourceId, freightSettlementId),
        ),
      );

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 5 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    const org = new OrgStructureService(db);
    const fiscal = new FiscalPeriodService(db);
    const numbering = new NumberingService(db);
    const glAccounts = new GlAccountService(db);
    const registry = new DbCurrencyRegistry(db);
    const currencies = new CurrencyService(db, registry);
    const accountDet = new AccountDeterminationService(db);
    const docFlow = new DocFlowService(db);
    const partners = new BusinessPartnerService(db);
    journals = new JournalService(
      db,
      fiscal,
      numbering,
      new OutboxService(db),
      docFlow,
      glAccounts,
      registry,
      currencies,
      accountDet,
    );
    freight = new FreightSettlementService(
      db,
      journals,
      partners,
      numbering,
      docFlow,
      accountDet,
      registry,
      currencies,
    );

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
    await fiscal.generateYear(companyCodeId, 2026);
    await fiscal.generateYear(otherCompanyCodeId, 2026);
    await currencies.ensureCurrency({ code: 'KRW', name: 'South Korean Won', minorUnit: 0 });
    await currencies.ensureCurrency({ code: 'USD', name: 'US Dollar', minorUnit: 2 });
    await currencies.ensureFxRate({
      fromCurrency: 'USD',
      toCurrency: 'KRW',
      rateType: 'M',
      validFrom: '2026-03-01',
      rate: '1350.000000',
    });

    for (const range of [
      { object: 'finance.journal_entry', scope: '2026', prefix: 'JE-2026-' },
      { object: 'finance.ap_invoice', scope: '2026', prefix: 'KR-2026-' },
      { object: 'logistics.freight_settlement', prefix: 'FR-' },
    ]) {
      await numbering.defineRange({ padding: 6, ...range });
    }

    for (const acc of [
      { accountNumber: '5300', name: '지급운임', accountType: 'EXPENSE' as const },
      {
        accountNumber: '2100',
        name: '외상매입금',
        accountType: 'LIABILITY' as const,
        isReconciliation: true,
      },
      // FX_ROUNDING plug (currency null by omission) — defensive; a 2-line freight entry never triggers it.
      { accountNumber: '9800', name: '외환차손익', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }
    for (const rule of [
      { transactionKey: 'FREIGHT', glAccount: '5300' },
      { transactionKey: 'FX_ROUNDING', glAccount: '9800' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    // The forwarder (포워더) — a vendor whose AP recon is 2100. The freight AP currency follows the invoice,
    // not the BP. A second BP carries NO vendor role (the negative-path subject).
    forwarderBpId = await partners.ensureBp({
      code: 'V-FWD',
      name: 'Global Forwarding Co.',
      bpType: 'ORGANIZATION',
      country: 'KR',
      city: 'Seoul',
    });
    await partners.ensureVendorRole(forwarderBpId, {
      apReconAccount: '2100',
      paymentTermsDays: 30,
      purchasingBlock: false,
    });
    noRoleBpId = await partners.ensureBp({
      code: 'BP-NOROLE',
      name: 'No Vendor Role Co.',
      bpType: 'ORGANIZATION',
      country: 'KR',
    });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — domestic freight: FR- doc no, ONE KR journal (Dr 5300 / Cr 2100 +forwarder), balanced, SETTLES + POSTS.
  it('settles domestic freight onto a shipment: KR journal Dr 지급운임 / Cr AP, SETTLES + POSTS edges', async () => {
    const shipmentId = await makeShipment(companyCodeId);
    const journalsBefore = await journalCount();

    const fs = await freight.post(
      {
        companyCodeId,
        shipmentId,
        forwarderBpId,
        currency: 'KRW',
        freightAmount: '50000',
        postingDate: '2026-03-12',
        documentDate: '2026-03-12',
        reference: 'FWD-INV-1001',
        postingKey: `freight:${shipmentId}`,
      },
      'tester',
    );

    expect(fs.docNo).toMatch(/^FR-\d{6}$/);
    expect(fs.status).toBe('POSTED');
    expect(fs.replayed).toBeFalsy();
    expect(fs.currency).toBe('KRW');
    expect(fs.freightAmount).toBe('50000.0000');
    expect(fs.reconAccount).toBe('2100');

    // Exactly one journal was created.
    expect(await journalCount()).toBe(journalsBefore + 1);

    const entry = await journals.getJournal(fs.journalId);
    expect(entry.docType).toBe('KR');
    expect(entry.docNo).toMatch(/^KR-2026-\d{6}$/);
    expect(entry.fxRate).toBeNull();
    // Exactly two lines: Dr 지급운임 5300, Cr 외상매입금 2100 (+forwarder partner). No VAT, no FX residue.
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines.find((l) => l.glAccount === '5300')).toMatchObject({
      drCr: 'D',
      amount: '50000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '2100')).toMatchObject({
      drCr: 'C',
      amount: '50000.0000',
      partnerId: forwarderBpId,
    });
    // Balanced: Σ debit == Σ credit.
    const debit = entry.lines
      .filter((l) => l.drCr === 'D')
      .reduce((s, l) => s + Number(l.amount), 0);
    const credit = entry.lines
      .filter((l) => l.drCr === 'C')
      .reduce((s, l) => s + Number(l.amount), 0);
    expect(debit).toBe(credit);

    // Header stamps no rate; reference stored.
    const [header] = await db
      .select()
      .from(schema.freightSettlement)
      .where(eq(schema.freightSettlement.id, fs.freightSettlementId));
    expect(header!.exchangeRate).toBeNull();
    expect(header!.reference).toBe('FWD-INV-1001');

    // doc_flow: exactly one POSTS → the journal, one SETTLES → the shipment.
    const edges = await edgesOf(fs.freightSettlementId);
    const posts = edges.filter((e) => e.relType === REL_POSTS);
    const settles = edges.filter((e) => e.relType === REL_SETTLES);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ targetType: DOC_FLOW_TYPE_JOURNAL, targetId: fs.journalId });
    expect(settles).toHaveLength(1);
    expect(settles[0]).toMatchObject({ targetType: DOC_FLOW_TYPE_SHIPMENT, targetId: shipmentId });

    // getFreightSettlement recovers the journal via the POSTS edge.
    const full = await freight.getFreightSettlement(fs.freightSettlementId);
    expect(full.journalId).toBe(fs.journalId);
  });

  // 2 — idempotent replay: same posting key → same document, journal once, no second freight row.
  it('replays a freight post idempotently (no second journal)', async () => {
    const shipmentId = await makeShipment(companyCodeId);
    const key = `freight:${shipmentId}`;
    const args = {
      companyCodeId,
      shipmentId,
      forwarderBpId,
      currency: 'KRW',
      freightAmount: '12000',
      postingDate: '2026-03-12',
      documentDate: '2026-03-12',
      postingKey: key,
    } as const;

    const first = await freight.post(args, 'tester');
    const journalsAfterFirst = await journalCount();

    const replay = await freight.post(args, 'tester');
    expect(replay.freightSettlementId).toBe(first.freightSettlementId);
    expect(replay.journalId).toBe(first.journalId);
    expect(replay.replayed).toBe(true);

    // No second journal, no second freight row.
    expect(await journalCount()).toBe(journalsAfterFirst);
    const rows = await db
      .select()
      .from(schema.freightSettlement)
      .where(eq(schema.freightSettlement.postingKey, key));
    expect(rows).toHaveLength(1);
  });

  // 3 — foreign freight: header rate stamped, journal in USD, both lines functional-translated, no FX_ROUNDING.
  it('settles foreign (USD) freight: header rate + both-currency tie-out, no FX_ROUNDING', async () => {
    const shipmentId = await makeShipment(companyCodeId);

    const fs = await freight.post(
      {
        companyCodeId,
        shipmentId,
        forwarderBpId,
        currency: 'USD',
        freightAmount: '100.00', // $100 → ₩135,000 at 1350
        postingDate: '2026-03-08',
        documentDate: '2026-03-08',
        postingKey: `freight:${shipmentId}`,
      },
      'tester',
    );
    expect(fs.currency).toBe('USD');
    expect(fs.freightAmount).toBe('100.0000');

    // Header stamps the applied rate.
    const [header] = await db
      .select()
      .from(schema.freightSettlement)
      .where(eq(schema.freightSettlement.id, fs.freightSettlementId));
    expect(header!.exchangeRate).toBe('1350.000000');

    const entry = await journals.getJournal(fs.journalId);
    expect(entry.currency).toBe('USD');
    expect(entry.fxRate).toBe('1350.000000');
    expect(entry.lines).toHaveLength(2);
    // Dr 지급운임: document $100, functional ₩135,000.
    expect(entry.lines.find((l) => l.glAccount === '5300')).toMatchObject({
      drCr: 'D',
      amount: '100.0000',
      functionalAmount: '135000.0000',
    });
    // Cr AP: document $100, functional ₩135,000, +forwarder partner.
    expect(entry.lines.find((l) => l.glAccount === '2100')).toMatchObject({
      drCr: 'C',
      amount: '100.0000',
      functionalAmount: '135000.0000',
      partnerId: forwarderBpId,
    });
    // No FX_ROUNDING plug — a 2-line entry whose recon leg carries its functional amount ties out exactly.
    expect(entry.lines.find((l) => l.glAccount === '9800')).toBeUndefined();
  });

  // 4 — read-only shipment + forwarder guards.
  it('rejects an unknown shipment, a foreign-company shipment, and a forwarder with no vendor role', async () => {
    const shipmentId = await makeShipment(companyCodeId);

    // Unknown shipment → 404.
    await expect(
      freight.post(
        {
          companyCodeId,
          shipmentId: randomUUID(),
          forwarderBpId,
          currency: 'KRW',
          freightAmount: '1000',
          postingDate: '2026-03-12',
          documentDate: '2026-03-12',
        },
        'tester',
      ),
    ).rejects.toThrow(/shipment .* not found/);

    // A shipment of another company cannot be settled under this company → 400.
    const foreignShipment = await makeShipment(otherCompanyCodeId);
    await expect(
      freight.post(
        {
          companyCodeId,
          shipmentId: foreignShipment,
          forwarderBpId,
          currency: 'KRW',
          freightAmount: '1000',
          postingDate: '2026-03-12',
          documentDate: '2026-03-12',
        },
        'tester',
      ),
    ).rejects.toThrow(/belongs to another company code/);

    // A forwarder BP without a vendor role → 400.
    await expect(
      freight.post(
        {
          companyCodeId,
          shipmentId,
          forwarderBpId: noRoleBpId,
          currency: 'KRW',
          freightAmount: '1000',
          postingDate: '2026-03-12',
          documentDate: '2026-03-12',
        },
        'tester',
      ),
    ).rejects.toThrow(/no vendor \(AP\) role/);
  });

  // 5 — the KR journal is subledger-owned (POSTS edge) → a direct FI reverse is refused.
  it('refuses to reverse the freight KR journal directly (subledger-owned via POSTS)', async () => {
    const shipmentId = await makeShipment(companyCodeId);
    const fs = await freight.post(
      {
        companyCodeId,
        shipmentId,
        forwarderBpId,
        currency: 'KRW',
        freightAmount: '7000',
        postingDate: '2026-03-12',
        documentDate: '2026-03-12',
        postingKey: `freight:${shipmentId}`,
      },
      'tester',
    );

    await expect(journals.reverse(fs.journalId, 'should be refused')).rejects.toThrow(/subledger/);
  });
});
