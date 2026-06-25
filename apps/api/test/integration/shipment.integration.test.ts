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
import { FiscalPeriodService } from '../../src/domains/platform/admin-config/fiscal-period.service.js';
import { NumberingService } from '../../src/domains/platform/numbering/numbering.service.js';
import { OutboxService } from '../../src/domains/platform/outbox/outbox.service.js';
import { DocFlowService } from '../../src/domains/platform/doc-flow/doc-flow.service.js';
import { AccountDeterminationService } from '../../src/domains/platform/admin-config/account-determination.service.js';
import { GlAccountService } from '../../src/domains/master-data/gl-account/gl-account.service.js';
import { DbCurrencyRegistry } from '../../src/domains/master-data/currency/db-currency-registry.js';
import { CurrencyService } from '../../src/domains/master-data/currency/currency.service.js';
import { MaterialService } from '../../src/domains/master-data/material/material.service.js';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import { JournalService } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import { MaterialValuationService } from '../../src/domains/inventory-warehouse/inventory/material-valuation.service.js';
import { GoodsMovementService } from '../../src/domains/inventory-warehouse/goods-movement/goods-movement.service.js';
import { SalesQueryService } from '../../src/domains/sales/sales-query.service.js';
import { SalesOrderService } from '../../src/domains/sales/sales-order/sales-order.service.js';
import { DeliveryService } from '../../src/domains/sales/delivery/delivery.service.js';
import { ShipmentService } from '../../src/domains/logistics-4pl/shipment/shipment.service.js';
import {
  DOC_FLOW_TYPE_DELIVERY,
  REL_CONTAINS,
} from '../../src/domains/logistics-4pl/logistics-4pl.constants.js';

/**
 * Shipment (선적) integration over a real PostgreSQL 16 (Testcontainers, §5.4). The 4PL backbone slice posts
 * NOTHING to FI, so this proves the non-posting physical document end-to-end: it builds real O2C sources
 * (SO → 601 delivery/GI), then shipments over them — docNo SH-NNNNNN, the `CONTAINS` doc_flow edge per
 * delivery (onto the `sales.delivery` node), 1:1 and 1:N (consolidation), the forward-only lifecycle
 * (PLANNED → BOOKED → DEPARTED → ARRIVED) with its atomic guards (skip/backward rejected), the read-only
 * company check (a foreign delivery is rejected), duplicate/unknown delivery guards, and that NO journal is
 * ever written by a shipment.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

interface DeliveryCtx {
  companyCodeId: string;
  plantId: string;
  slocId: string;
}

describe.skipIf(!dockerAvailable)('logistics-4pl 선적 (shipment) (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let movements: GoodsMovementService;
  let salesOrders: SalesOrderService;
  let deliveries: DeliveryService;
  let shipments: ShipmentService;
  let ctx1: DeliveryCtx;
  let ctx2: DeliveryCtx;
  let customerBpId: string;

  const journalCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalEntry);
    return row?.c ?? 0;
  };

  let matSeq = 0;
  /** Build a real delivery (FINISHED material + 561 stock → SO → 601 delivery) under `ctx`; return its id. */
  const makeDelivery = async (ctx: DeliveryCtx): Promise<string> => {
    matSeq += 1;
    const materials = new MaterialService(db);
    const id = await materials.ensureMaterial({
      code: `SHIP-MAT-${matSeq}`,
      name: `Shipment material ${matSeq}`,
      materialType: 'FINISHED',
      baseUom: 'EA',
    });
    await new MaterialValuationService(db).ensureValuation({
      materialId: id,
      plantId: ctx.plantId,
      valuationClass: '3000',
    });
    await movements.post({
      plantId: ctx.plantId,
      movementType: '561',
      postingDate: '2026-03-01',
      items: [{ materialId: id, storageLocationId: ctx.slocId, qty: '100', unitPrice: '100' }],
    });
    const so = await salesOrders.create({
      companyCodeId: ctx.companyCodeId,
      customerBpId,
      currency: 'KRW',
      orderDate: '2026-03-02',
      items: [
        {
          materialId: id,
          plantId: ctx.plantId,
          storageLocationId: ctx.slocId,
          orderedQty: '10',
          unitPrice: '100',
        },
      ],
    });
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;
    const delivery = await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-03',
      items: [{ salesOrderItemId: soItemId, qty: '10' }],
    });
    return delivery.deliveryId;
  };

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
    const journals = new JournalService(
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
    movements = new GoodsMovementService(
      db,
      fiscal,
      numbering,
      docFlow,
      journals,
      accountDet,
      registry,
    );
    const salesQuery = new SalesQueryService(db);
    salesOrders = new SalesOrderService(db, partners, numbering);
    deliveries = new DeliveryService(db, movements, salesQuery);
    shipments = new ShipmentService(db, numbering, docFlow);

    const company1 = await org.createCompanyCode({
      code: '1000',
      name: 'Heyday Trading',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    const company2 = await org.createCompanyCode({
      code: '2000',
      name: 'Other Co',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    await fiscal.generateYear(company1.id, 2026);
    await fiscal.generateYear(company2.id, 2026);
    await currencies.ensureCurrency({ code: 'KRW', name: 'South Korean Won', minorUnit: 0 });

    for (const range of [
      { object: 'finance.journal_entry', scope: '2026', prefix: 'JE-2026-' },
      { object: 'inventory.goods_movement', scope: '2026', prefix: 'GM-2026-' },
      { object: 'sales.sales_order', prefix: 'SO-' },
      { object: 'logistics.shipment', prefix: 'SH-' },
    ]) {
      await numbering.defineRange({ padding: 6, ...range });
    }

    for (const acc of [
      {
        accountNumber: '1100',
        name: '외상매출금',
        accountType: 'ASSET' as const,
        isReconciliation: true,
      },
      { accountNumber: '1300', name: '재고자산', accountType: 'ASSET' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
      { accountNumber: '5200', name: '매출원가', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({
        chartOfAccounts: 'KR01',
        isReconciliation: false,
        ...acc,
      });
    }
    for (const rule of [
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' },
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' },
      { transactionKey: 'COGS', glAccount: '5200' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    const plant1 = await org.ensurePlant({
      code: '1010',
      name: 'Seoul Plant',
      companyCodeId: company1.id,
    });
    const sloc1 = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId: plant1 });
    const plant2 = await org.ensurePlant({
      code: '2010',
      name: 'Busan Plant',
      companyCodeId: company2.id,
    });
    const sloc2 = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId: plant2 });
    ctx1 = { companyCodeId: company1.id, plantId: plant1, slocId: sloc1 };
    ctx2 = { companyCodeId: company2.id, plantId: plant2, slocId: sloc2 };

    customerBpId = await partners.ensureBp({
      code: 'C-BUYER',
      name: 'Foreign Buyer LLC',
      bpType: 'ORGANIZATION',
      country: 'US',
    });
    await partners.ensureCustomerRole(customerBpId, {
      arReconAccount: '1100',
      paymentTermsDays: 30,
      salesBlock: false,
    });
  }, 180_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — single-delivery shipment (1:1): SH- doc no, PLANNED, one CONTAINS edge onto the delivery, no journal.
  it('creates a single-delivery shipment (SH-, PLANNED, one CONTAINS edge, no journal)', async () => {
    const d1 = await makeDelivery(ctx1);

    const journalsBefore = await journalCount();
    const created = await shipments.create(
      {
        companyCodeId: ctx1.companyCodeId,
        transportMode: 'SEA',
        carrier: 'HMM',
        portOfLoading: 'KRPUS',
        portOfDischarge: 'USLAX',
        etd: '2026-03-10',
        items: [{ deliveryId: d1 }],
      },
      'tester',
    );

    expect(created.docNo).toMatch(/^SH-\d{6}$/);
    expect(created.status).toBe('PLANNED');

    // The shipment posts NOTHING to FI.
    expect(await journalCount()).toBe(journalsBefore);

    const full = await shipments.getShipment(created.shipmentId);
    expect(full.status).toBe('PLANNED');
    expect(full.transportMode).toBe('SEA');
    expect(full.items).toHaveLength(1);
    expect(full.items[0]).toMatchObject({ deliveryId: d1, lineNo: 1 });

    const contains = full.lineage.filter((e) => e.relType === REL_CONTAINS);
    expect(contains).toHaveLength(1);
    expect(contains[0]).toMatchObject({ targetType: DOC_FLOW_TYPE_DELIVERY, targetId: d1 });
  });

  // 2 — consolidation (1:N): two deliveries → two lines, two CONTAINS edges.
  it('consolidates multiple deliveries (1:N) into one shipment with N lines and N CONTAINS edges', async () => {
    const dA = await makeDelivery(ctx1);
    const dB = await makeDelivery(ctx1);
    const created = await shipments.create(
      {
        companyCodeId: ctx1.companyCodeId,
        transportMode: 'AIR',
        items: [{ deliveryId: dA }, { deliveryId: dB }],
      },
      'tester',
    );
    const full = await shipments.getShipment(created.shipmentId);
    expect(full.items).toHaveLength(2);
    const contains = full.lineage.filter((e) => e.relType === REL_CONTAINS);
    expect(contains).toHaveLength(2);
    expect(contains.map((e) => e.targetId).sort()).toEqual([dA, dB].sort());
  });

  // 3 — forward-only lifecycle: PLANNED → BOOKED (stamps 운송서류번호) → DEPARTED → ARRIVED; no journal.
  it('advances the lifecycle PLANNED → BOOKED → DEPARTED → ARRIVED (no journal)', async () => {
    const d = await makeDelivery(ctx1);
    const created = await shipments.create(
      { companyCodeId: ctx1.companyCodeId, transportMode: 'SEA', items: [{ deliveryId: d }] },
      'tester',
    );

    const journalsBefore = await journalCount();
    const booked = await shipments.book(created.shipmentId, {
      transportDocNo: 'HMMU1234567',
      vesselFlightNo: 'HMM OSAKA 23W',
    });
    expect(booked).toMatchObject({
      status: 'BOOKED',
      transportDocNo: 'HMMU1234567',
      vesselFlightNo: 'HMM OSAKA 23W',
    });
    const departed = await shipments.depart(created.shipmentId);
    expect(departed.status).toBe('DEPARTED');
    const arrived = await shipments.arrive(created.shipmentId);
    expect(arrived.status).toBe('ARRIVED');

    // No journal across any transition.
    expect(await journalCount()).toBe(journalsBefore);
  });

  // 4 — illegal transitions: skipping a step or re-running one is rejected (409, atomic guard).
  it('rejects skipping or repeating a lifecycle step', async () => {
    const d = await makeDelivery(ctx1);
    const created = await shipments.create(
      { companyCodeId: ctx1.companyCodeId, transportMode: 'SEA', items: [{ deliveryId: d }] },
      'tester',
    );

    // PLANNED → depart (expects BOOKED) and PLANNED → arrive (expects DEPARTED) both 409.
    await expect(shipments.depart(created.shipmentId)).rejects.toThrow(
      /cannot transition to DEPARTED/,
    );
    await expect(shipments.arrive(created.shipmentId)).rejects.toThrow(
      /cannot transition to ARRIVED/,
    );

    // Book it, then a second book (BOOKED → BOOKED) is rejected.
    await shipments.book(created.shipmentId, {});
    await expect(shipments.book(created.shipmentId, {})).rejects.toThrow(
      /cannot transition to BOOKED/,
    );
  });

  // 5 — read-only company check: a delivery of another company cannot be shipped under this company.
  it('rejects a delivery that belongs to another company code', async () => {
    const foreign = await makeDelivery(ctx2);
    await expect(
      shipments.create(
        {
          companyCodeId: ctx1.companyCodeId,
          transportMode: 'SEA',
          items: [{ deliveryId: foreign }],
        },
        'tester',
      ),
    ).rejects.toThrow(/belongs to another company code/);
  });

  // 6 — guards: a duplicate deliveryId in one request, and an unknown delivery, are both rejected.
  it('rejects a duplicate deliveryId and an unknown delivery', async () => {
    const d = await makeDelivery(ctx1);
    await expect(
      shipments.create(
        {
          companyCodeId: ctx1.companyCodeId,
          transportMode: 'SEA',
          items: [{ deliveryId: d }, { deliveryId: d }],
        },
        'tester',
      ),
    ).rejects.toThrow(/duplicate deliveryId/);

    await expect(
      shipments.create(
        {
          companyCodeId: ctx1.companyCodeId,
          transportMode: 'SEA',
          items: [{ deliveryId: randomUUID() }],
        },
        'tester',
      ),
    ).rejects.toThrow(/delivery .* not found/);
  });
});
