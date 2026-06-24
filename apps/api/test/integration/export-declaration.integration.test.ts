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
import { MaterialService } from '../../src/domains/master-data/material/material.service.js';
import { TaxCodeService } from '../../src/domains/master-data/tax-code/tax-code.service.js';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import { JournalService } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import { MaterialValuationService } from '../../src/domains/inventory-warehouse/inventory/material-valuation.service.js';
import { GoodsMovementService } from '../../src/domains/inventory-warehouse/goods-movement/goods-movement.service.js';
import { SalesQueryService } from '../../src/domains/sales/sales-query.service.js';
import { SalesOrderService } from '../../src/domains/sales/sales-order/sales-order.service.js';
import { DeliveryService } from '../../src/domains/sales/delivery/delivery.service.js';
import { BillingService } from '../../src/domains/sales/billing/billing.service.js';
import { ExportDeclarationService } from '../../src/domains/trade-compliance/export-declaration/export-declaration.service.js';
import {
  DOC_FLOW_TYPE_DELIVERY,
  DOC_FLOW_TYPE_EXPORT_DECLARATION,
  REL_DECLARES,
} from '../../src/domains/trade-compliance/trade-compliance.constants.js';

/**
 * Export-declaration (수출신고) integration over a real PostgreSQL 16 (Testcontainers, §5.4). The slice
 * posts NOTHING to FI, so this proves the non-posting customs document end-to-end: it builds the real
 * O2C source (SO → 601 delivery/GI), then a declaration over it — docNo ED-NNNNNN, the HS/origin SNAPSHOT
 * from material_trade, the FOB total via Money, the foreign FX stamp, the `DECLARES` doc_flow edge onto
 * the delivery's GI (`inventory.goods_movement`), accept() stamping the 수출신고번호 (MRN) + SUBMITTED→
 * ACCEPTED, that NO journal is written, and the read-only 영세율 gate across its three billing states
 * (no billing → INFO, V00 → clean, taxable V10 → WARN).
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('trade-compliance 수출신고 (export declaration) (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let movements: GoodsMovementService;
  let salesOrders: SalesOrderService;
  let deliveries: DeliveryService;
  let billings: BillingService;
  let exportDeclarations: ExportDeclarationService;
  let companyCodeId: string;
  let plantId: string;
  let slocA: string;
  let customerBpId: string;
  let brokerBpId: string;

  const journalCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalEntry);
    return row?.c ?? 0;
  };

  /** Stock a material at a storage location via a priced 561 initial load (Dr BSX / Cr GBB). */
  const load561 = (materialId: string, qty: string, price: string) =>
    movements.post({
      plantId,
      movementType: '561',
      postingDate: '2026-03-01',
      items: [{ materialId, storageLocationId: slocA, qty, unitPrice: price }],
    });

  let matSeq = 0;
  /** A FINISHED material with a trade extension (HS + origin) + stock, ready to sell and declare. */
  const newTradeMaterial = async (hsCode: string, origin: string, qty = '100', price = '100') => {
    matSeq += 1;
    const materials = new MaterialService(db);
    const id = await materials.ensureMaterial({
      code: `ED-${matSeq}`,
      name: `Export material ${matSeq}`,
      materialType: 'FINISHED',
      baseUom: 'EA',
    });
    await new MaterialValuationService(db).ensureValuation({ materialId: id, plantId, valuationClass: '3000' });
    await materials.ensureTradeData(id, { hsCode, countryOfOrigin: origin });
    if (Number(qty) > 0) await load561(id, qty, price);
    return id;
  };

  /** SO → 601 delivery for `materialId`; returns the delivery (deliveryId + goodsMovementId) + soItemId. */
  const sellAndDeliver = async (
    materialId: string,
    qty: string,
    price: string,
    taxCode: string | undefined,
    currency: string,
  ) => {
    const so = await salesOrders.create({
      companyCodeId,
      customerBpId,
      currency,
      orderDate: '2026-03-02',
      items: [{ materialId, plantId, storageLocationId: slocA, orderedQty: qty, unitPrice: price, taxCode }],
    });
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;
    const delivery = await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-03',
      items: [{ salesOrderItemId: soItemId, qty }],
    });
    return { salesOrderId: so.salesOrderId, soItemId, deliveryId: delivery.deliveryId, goodsMovementId: delivery.goodsMovementId };
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
    movements = new GoodsMovementService(db, fiscal, numbering, docFlow, journals, accountDet, registry);
    const salesQuery = new SalesQueryService(db);
    salesOrders = new SalesOrderService(db, partners, numbering);
    deliveries = new DeliveryService(db, movements, salesQuery);
    billings = new BillingService(db, journals, partners, numbering, docFlow, salesQuery, registry);
    exportDeclarations = new ExportDeclarationService(db, partners, numbering, docFlow, currencies, registry);

    const company = await org.createCompanyCode({
      code: '1000',
      name: 'Heyday Trading',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    companyCodeId = company.id;
    await fiscal.generateYear(companyCodeId, 2026);
    await currencies.ensureCurrency({ code: 'KRW', name: 'South Korean Won', minorUnit: 0 });
    await currencies.ensureCurrency({ code: 'USD', name: 'US Dollar', minorUnit: 2 });
    await currencies.ensureFxRate({ fromCurrency: 'USD', toCurrency: 'KRW', rateType: 'M', validFrom: '2026-03-01', rate: '1300.000000' });

    for (const range of [
      { object: 'finance.journal_entry', scope: '2026', prefix: 'JE-2026-' },
      { object: 'finance.ar_invoice', scope: '2026', prefix: 'DR-2026-' },
      { object: 'inventory.goods_movement', scope: '2026', prefix: 'GM-2026-' },
      { object: 'sales.sales_order', prefix: 'SO-' },
      { object: 'sales.billing', prefix: 'BL-' },
      { object: 'trade.export_declaration', prefix: 'ED-' },
    ]) {
      await numbering.defineRange({ padding: 6, ...range });
    }

    for (const acc of [
      { accountNumber: '1100', name: '외상매출금', accountType: 'ASSET' as const, isReconciliation: true },
      { accountNumber: '1300', name: '원재료', accountType: 'ASSET' as const },
      { accountNumber: '2550', name: '부가세예수금', accountType: 'LIABILITY' as const },
      { accountNumber: '4000', name: '제품매출', accountType: 'REVENUE' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
      { accountNumber: '5200', name: '매출원가', accountType: 'EXPENSE' as const },
      { accountNumber: '9800', name: '외환차손익', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }
    for (const rule of [
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' },
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' },
      { transactionKey: 'COGS', glAccount: '5200' },
      { transactionKey: 'FX_ROUNDING', glAccount: '9800' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocA = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId });

    customerBpId = await partners.ensureBp({ code: 'C-BUYER', name: 'Foreign Buyer LLC', bpType: 'ORGANIZATION', country: 'US' });
    await partners.ensureCustomerRole(customerBpId, { arReconAccount: '1100', paymentTermsDays: 30, salesBlock: false });
    brokerBpId = await partners.ensureBp({ code: 'C-BROKER', name: '관세사 Customs Broker', bpType: 'ORGANIZATION', country: 'KR' });

    const taxCodes = new TaxCodeService(db);
    await taxCodes.ensureTaxCode({ code: 'V10', name: '매출 부가세 10%', kind: 'OUTPUT', ratePercent: '10', glAccount: '2550' });
    await taxCodes.ensureTaxCode({ code: 'V00', name: '매출 영세율', kind: 'OUTPUT', ratePercent: '0', glAccount: '2550' });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — full create: ED- doc no, HS/origin snapshot, FOB total, foreign FX stamp, DECLARES → GI, NO journal,
  //     then accept() stamps the MRN (SUBMITTED → ACCEPTED) and a second accept is rejected.
  it('creates a USD declaration (HS snapshot + FX stamp + DECLARES edge, no journal) and accepts it', async () => {
    const matId = await newTradeMaterial('8471606000', 'KR', '10', '100');
    const src = await sellAndDeliver(matId, '10', '100', 'V00', 'USD');

    const journalsBefore = await journalCount();
    const created = await exportDeclarations.create({
      companyCodeId,
      customerBpId,
      brokerBpId,
      sourceDeliveryId: src.deliveryId,
      declarationDate: '2026-03-05',
      currency: 'USD',
      shipToCountry: 'US',
      // HS code omitted on the line → snapshotted from material_trade.
      items: [{ materialId: matId, qty: '10', uom: 'EA', fobAmount: '1000.00', netWeight: '4.5' }],
    });

    expect(created.docNo).toMatch(/^ED-\d{6}$/);
    expect(created.status).toBe('SUBMITTED');
    // No billing exists yet → INFO (not WARN); HS resolved → no HS warning.
    expect(created.warnings).toContainEqual(expect.objectContaining({ severity: 'INFO', code: 'BILLING_NOT_CREATED' }));
    expect(created.warnings.find((w) => w.code === 'HS_CODE_MISSING')).toBeUndefined();

    // A declaration posts NOTHING to FI.
    expect(await journalCount()).toBe(journalsBefore);

    const full = await exportDeclarations.getExportDeclaration(created.exportDeclarationId);
    expect(full.totalFobAmount).toBe('1000.0000');
    expect(full.exchangeRate).toBe('1300.000000'); // foreign → document-date 'M' rate stamped
    expect(full.currency).toBe('USD');
    expect(full.items).toHaveLength(1);
    expect(full.items[0]).toMatchObject({
      hsCode: '8471606000', // snapshot from material_trade
      originCountry: 'KR',
      qty: '10.000000',
      uom: 'EA',
      fobAmount: '1000.0000',
      netWeight: '4.500000',
    });

    // Physical lineage: DECLARES → the delivery's 601 GI (inventory.goods_movement).
    const edges = await db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_EXPORT_DECLARATION),
          eq(schema.docFlow.sourceId, created.exportDeclarationId),
          eq(schema.docFlow.relType, REL_DECLARES),
        ),
      );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ targetType: DOC_FLOW_TYPE_DELIVERY, targetId: src.goodsMovementId });
    expect(DOC_FLOW_TYPE_DELIVERY).toBe('inventory.goods_movement');

    // accept(): stamp the externally-issued 수출신고번호 (MRN — UNCHANGED behavior) + the ADDITIVE 신고수리일
    // (the duty-drawback slice's only export change). Regression: the MRN stamp + status flip are unchanged.
    const accepted = await exportDeclarations.accept(created.exportDeclarationId, {
      declarationNo: '41234-26-700001X',
      acceptanceDate: '2026-03-12',
    });
    expect(accepted).toMatchObject({
      status: 'ACCEPTED',
      declarationNo: '41234-26-700001X', // MRN stamp unchanged
      acceptanceDate: '2026-03-12', // additive 수리일 stamp
    });

    // A second accept is rejected (only a SUBMITTED declaration can be accepted) — guard unchanged.
    await expect(
      exportDeclarations.accept(created.exportDeclarationId, { declarationNo: 'X' }),
    ).rejects.toThrow(/only a SUBMITTED declaration can be accepted/);
  });

  // 2 — G2 read-only gate, clean: a V00 (영세율) billing on the declared SO → no G2 warning at all.
  it('emits no 영세율 warning when the declared delivery has a zero-rate (V00) billing', async () => {
    const matId = await newTradeMaterial('8471606000', 'KR', '5', '100');
    const src = await sellAndDeliver(matId, '5', '300', 'V00', 'KRW');
    await billings.post({
      companyCodeId,
      salesOrderId: src.salesOrderId,
      reference: 'INV-V00',
      postingDate: '2026-03-04',
      documentDate: '2026-03-04',
      currency: 'KRW',
      items: [{ salesOrderItemId: src.soItemId, qty: '5', revenueAccount: '4000' }],
    });

    const created = await exportDeclarations.create({
      companyCodeId,
      customerBpId,
      sourceDeliveryId: src.deliveryId,
      declarationDate: '2026-03-05',
      currency: 'KRW',
      items: [{ materialId: matId, qty: '5', uom: 'EA', fobAmount: '1500' }],
    });
    // Billing exists and is zero-rated, HS resolved, EXP default → clean.
    expect(created.warnings).toEqual([]);
    const full = await exportDeclarations.getExportDeclaration(created.exportDeclarationId);
    expect(full.exchangeRate).toBeNull(); // domestic — no rate stamped
  });

  // 3 — G2 read-only gate, WARN: a taxable (V10, rate>0) billing on the declared SO → 영세율 WARN (B1).
  it('warns (영세율 미적용) when the declared delivery has a taxable (V10) billing', async () => {
    const matId = await newTradeMaterial('8471606000', 'KR', '5', '100');
    const src = await sellAndDeliver(matId, '5', '300', 'V10', 'KRW');
    await billings.post({
      companyCodeId,
      salesOrderId: src.salesOrderId,
      reference: 'INV-V10',
      postingDate: '2026-03-04',
      documentDate: '2026-03-04',
      currency: 'KRW',
      items: [{ salesOrderItemId: src.soItemId, qty: '5', revenueAccount: '4000' }],
    });

    const created = await exportDeclarations.create({
      companyCodeId,
      customerBpId,
      sourceDeliveryId: src.deliveryId,
      declarationDate: '2026-03-05',
      currency: 'KRW',
      items: [{ materialId: matId, qty: '5', uom: 'EA', fobAmount: '1500' }],
    });
    expect(created.warnings).toContainEqual(
      expect.objectContaining({ severity: 'WARN', code: 'ZERO_RATE_TAX_CODE_MISSING' }),
    );
    expect(created.warnings.find((w) => w.code === 'BILLING_NOT_CREATED')).toBeUndefined();
  });

  // 3b — G2 read-only gate, B1 closure: a billing line with NO tax_code (NULL) → 영세율 WARN end-to-end.
  it('warns (B1) when the declared delivery has a billing line carrying NO tax_code', async () => {
    const matId = await newTradeMaterial('8471606000', 'KR', '5', '100');
    // SO line with NO tax code → the billing line it raises carries a NULL tax_code.
    const src = await sellAndDeliver(matId, '5', '300', undefined, 'KRW');
    await billings.post({
      companyCodeId,
      salesOrderId: src.salesOrderId,
      reference: 'INV-NULL',
      postingDate: '2026-03-04',
      documentDate: '2026-03-04',
      currency: 'KRW',
      items: [{ salesOrderItemId: src.soItemId, qty: '5', revenueAccount: '4000' }],
    });

    const created = await exportDeclarations.create({
      companyCodeId,
      customerBpId,
      sourceDeliveryId: src.deliveryId,
      declarationDate: '2026-03-05',
      currency: 'KRW',
      items: [{ materialId: matId, qty: '5', uom: 'EA', fobAmount: '1500' }],
    });
    expect(created.warnings).toContainEqual(
      expect.objectContaining({ severity: 'WARN', code: 'ZERO_RATE_TAX_CODE_MISSING' }),
    );
    expect(created.warnings.find((w) => w.code === 'BILLING_NOT_CREATED')).toBeUndefined();
  });

  // 4 — guards: an unknown source delivery and an unknown material are both rejected (404).
  it('rejects an unknown source delivery and an unknown material', async () => {
    const matId = await newTradeMaterial('8471606000', 'KR', '5', '100');
    const src = await sellAndDeliver(matId, '5', '100', 'V00', 'KRW');

    await expect(
      exportDeclarations.create({
        companyCodeId,
        customerBpId,
        sourceDeliveryId: randomUUID(),
        declarationDate: '2026-03-05',
        currency: 'KRW',
        items: [{ materialId: matId, qty: '5', uom: 'EA', fobAmount: '500' }],
      }),
    ).rejects.toThrow(/delivery .* not found/);

    await expect(
      exportDeclarations.create({
        companyCodeId,
        customerBpId,
        sourceDeliveryId: src.deliveryId,
        declarationDate: '2026-03-05',
        currency: 'KRW',
        items: [{ materialId: randomUUID(), qty: '5', uom: 'EA', fobAmount: '500' }],
      }),
    ).rejects.toThrow(/material .* not found/);
  });
});
