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
import { ExportDeclarationService } from '../../src/domains/trade-compliance/export-declaration/export-declaration.service.js';
import { ImportDeclarationService } from '../../src/domains/trade-compliance/import-declaration/import-declaration.service.js';
import { UnipassService } from '../../src/domains/trade-compliance/unipass/unipass.service.js';

/**
 * UNI-PASS connector (관세청 전자통관) integration over a real PostgreSQL 16 (Testcontainers, §5.4). The slice is
 * a synchronous STUB that "transmits" a SUBMITTED declaration to 관세청 and records the 수리(ACCEPTED)/반려
 * (REJECTED) verdict — it posts NOTHING to FI. This proves, for BOTH twin declarations (수출신고 / 수입신고):
 *   • submit(ACCEPTED) → declaration ACCEPTED + declaration_no = MRN + 신고수리일 stamp + one OUTBOUND log row;
 *   • submit(REJECTED) → declaration REJECTED (terminal — no MRN, no 수리일) + one log row carrying the 사유;
 *   • re-transmitting a non-SUBMITTED declaration 409s (멀티전송/재전송 is backlog — the 1:N log schema is
 *     present but v1 only transmits a still-SUBMITTED declaration);
 *   • a provided MRN overrides the stub MRN;
 *   • the transmission writes NO journal_entry (external-integration slice, not accounting);
 *   • guards: unknown declaration → 404, an invalid declarationType → 400.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('trade-compliance UNI-PASS connector (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let movements: GoodsMovementService;
  let salesOrders: SalesOrderService;
  let deliveries: DeliveryService;
  let exportDeclarations: ExportDeclarationService;
  let importDeclarations: ImportDeclarationService;
  let unipass: UnipassService;
  let companyCodeId: string;
  let plantId: string;
  let slocA: string;
  let customerBpId: string;
  let supplierBpId: string;
  let brokerBpId: string;

  const journalCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalEntry);
    return row?.c ?? 0;
  };

  let matSeq = 0;

  /** A FINISHED material (HS + origin) with stock via a 561 initial load — ready to sell, deliver, declare. */
  const newExportMaterial = async (hsCode: string, origin: string) => {
    matSeq += 1;
    const materials = new MaterialService(db);
    const id = await materials.ensureMaterial({
      code: `UP-EX-${matSeq}`,
      name: `Export material ${matSeq}`,
      materialType: 'FINISHED',
      baseUom: 'EA',
    });
    await new MaterialValuationService(db).ensureValuation({
      materialId: id,
      plantId,
      valuationClass: '3000',
    });
    await materials.ensureTradeData(id, { hsCode, countryOfOrigin: origin });
    await movements.post({
      plantId,
      movementType: '561',
      postingDate: '2026-03-01',
      items: [{ materialId: id, storageLocationId: slocA, qty: '100', unitPrice: '100' }],
    });
    return id;
  };

  /** A RAW material (HS + origin) for the import leg. */
  const newImportMaterial = async (hsCode: string, origin: string) => {
    matSeq += 1;
    const materials = new MaterialService(db);
    const id = await materials.ensureMaterial({
      code: `UP-IM-${matSeq}`,
      name: `Import material ${matSeq}`,
      materialType: 'RAW',
      baseUom: 'EA',
    });
    await new MaterialValuationService(db).ensureValuation({
      materialId: id,
      plantId,
      valuationClass: '3000',
    });
    await materials.ensureTradeData(id, { hsCode, countryOfOrigin: origin });
    return id;
  };

  /** SO → 601 delivery (KRW); returns the delivery + GI ids. */
  const sellAndDeliver = async (materialId: string, qty = '10', price = '100') => {
    const so = await salesOrders.create({
      companyCodeId,
      customerBpId,
      currency: 'KRW',
      orderDate: '2026-03-02',
      items: [{ materialId, plantId, storageLocationId: slocA, orderedQty: qty, unitPrice: price }],
    });
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;
    const delivery = await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-03',
      items: [{ salesOrderItemId: soItemId, qty }],
    });
    return { deliveryId: delivery.deliveryId, goodsMovementId: delivery.goodsMovementId };
  };

  /** A priced 101 import GR (Dr BSX / Cr WRX); returns its goods_movement + first line ids. */
  const receiveImport = async (materialId: string, qty = '10', price = '100') => {
    const gm = await movements.post(
      {
        plantId,
        movementType: '101',
        postingDate: '2026-03-02',
        items: [{ materialId, storageLocationId: slocA, qty, unitPrice: price }],
      },
      'system',
      { offsetKey: 'WRX' },
    );
    return { goodsMovementId: gm.goodsMovementId };
  };

  /** Create a SUBMITTED 수출신고 over a fresh delivery; returns its id. */
  const newExportDeclaration = async () => {
    const matId = await newExportMaterial('8471606000', 'KR');
    const src = await sellAndDeliver(matId);
    const created = await exportDeclarations.create({
      companyCodeId,
      customerBpId,
      sourceDeliveryId: src.deliveryId,
      declarationDate: '2026-03-05',
      currency: 'KRW',
      items: [{ materialId: matId, qty: '10', uom: 'EA', fobAmount: '1000' }],
    });
    return created.exportDeclarationId;
  };

  /** Create a SUBMITTED 수입신고 over a fresh 101 GR; returns its id. */
  const newImportDeclaration = async () => {
    const matId = await newImportMaterial('8471606000', 'CN');
    const gr = await receiveImport(matId);
    const created = await importDeclarations.create({
      companyCodeId,
      supplierBpId,
      sourceGoodsMovementId: gr.goodsMovementId,
      declarationDate: '2026-03-04',
      currency: 'KRW',
      customsValue: '1000',
      dutyAmount: '80',
      importVatAmount: '108',
      items: [{ materialId: matId, qty: '10', uom: 'EA', customsValue: '1000', dutyRate: '8' }],
    });
    return created.importDeclarationId;
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
    exportDeclarations = new ExportDeclarationService(
      db,
      partners,
      numbering,
      docFlow,
      currencies,
      registry,
    );
    importDeclarations = new ImportDeclarationService(
      db,
      partners,
      numbering,
      docFlow,
      currencies,
      registry,
    );
    unipass = new UnipassService(db);

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

    for (const range of [
      { object: 'finance.journal_entry', scope: '2026', prefix: 'JE-2026-' },
      { object: 'inventory.goods_movement', scope: '2026', prefix: 'GM-2026-' },
      { object: 'sales.sales_order', prefix: 'SO-' },
      { object: 'trade.export_declaration', prefix: 'ED-' },
      { object: 'trade.import_declaration', prefix: 'IM-' },
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
      {
        accountNumber: '2100',
        name: '외상매입금',
        accountType: 'LIABILITY' as const,
        isReconciliation: true,
      },
      { accountNumber: '2110', name: '입고미착', accountType: 'LIABILITY' as const },
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
      { transactionKey: 'WRX', glAccount: '2110' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocA = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId });

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
    supplierBpId = await partners.ensureBp({
      code: 'V-OVERSEAS',
      name: 'Shenzhen Components Ltd.',
      bpType: 'ORGANIZATION',
      country: 'CN',
    });
    await partners.ensureVendorRole(supplierBpId, {
      apReconAccount: '2100',
      paymentTermsDays: 45,
      purchasingBlock: false,
    });
    brokerBpId = await partners.ensureBp({
      code: 'C-BROKER',
      name: '관세사 Customs Broker',
      bpType: 'ORGANIZATION',
      country: 'KR',
    });
    void brokerBpId;
  }, 180_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — 수출신고 수리: submit(ACCEPTED) flips SUBMITTED→ACCEPTED, stamps the stub MRN + 신고수리일, writes one
  //     OUTBOUND log row, posts NO journal; a re-transmit of the now-ACCEPTED declaration 409s.
  it('transmits a 수출신고 (ACCEPTED) — stub MRN + 수리일 stamp, one log row, no journal', async () => {
    const edId = await newExportDeclaration();

    const journalsBefore = await journalCount();
    const res = await unipass.submit('EXPORT', edId, { acceptanceDate: '2026-03-12' }, 'tester');

    expect(res).toMatchObject({
      declarationType: 'EXPORT',
      declarationId: edId,
      status: 'ACCEPTED',
      result: 'ACCEPTED',
    });
    expect(res.mrn).toMatch(/^STUB-ED-/);

    // The transmission posts NOTHING to FI.
    expect(await journalCount()).toBe(journalsBefore);

    // The declaration owns status: it is now ACCEPTED with the MRN on declaration_no + the 수리일 stamped.
    const full = await exportDeclarations.getExportDeclaration(edId);
    expect(full.status).toBe('ACCEPTED');
    expect(full.declarationNo).toBe(res.mrn);
    expect(full.acceptanceDate).toBe('2026-03-12');

    // Exactly one OUTBOUND transmission log row.
    const messages = await unipass.getMessages('EXPORT', edId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      declarationType: 'EXPORT',
      declarationId: edId,
      direction: 'OUTBOUND',
      messageType: 'DECLARATION',
      result: 'ACCEPTED',
      mrn: res.mrn,
      responseMessage: null,
    });

    // Re-transmitting an already-ACCEPTED declaration is refused (only a SUBMITTED declaration transmits).
    await expect(unipass.submit('EXPORT', edId, {})).rejects.toThrow(
      /only a SUBMITTED declaration can be transmitted/,
    );
  });

  // 2 — 수입신고 수리 (twin), with an explicit MRN override that wins over the stub MRN.
  it('transmits a 수입신고 (ACCEPTED) — a provided MRN overrides the stub MRN (twin)', async () => {
    const imId = await newImportDeclaration();

    const journalsBefore = await journalCount();
    const res = await unipass.submit(
      'IMPORT',
      imId,
      { mrn: '41234-26-100777X', acceptanceDate: '2026-03-06' },
      'tester',
    );

    expect(res).toMatchObject({
      declarationType: 'IMPORT',
      status: 'ACCEPTED',
      result: 'ACCEPTED',
      mrn: '41234-26-100777X',
    });
    expect(await journalCount()).toBe(journalsBefore);

    const full = await importDeclarations.getImportDeclaration(imId);
    expect(full.status).toBe('ACCEPTED');
    expect(full.declarationNo).toBe('41234-26-100777X'); // override, not the stub
    expect(full.acceptanceDate).toBe('2026-03-06');

    const messages = await unipass.getMessages('IMPORT', imId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      result: 'ACCEPTED',
      mrn: '41234-26-100777X',
      direction: 'OUTBOUND',
    });
  });

  // 3 — 반려 (REJECTED): terminal, no MRN / no 수리일, the 사유 logged; no journal; a re-transmit 409s
  //     (the 1:N log schema is present but v1 only transmits a still-SUBMITTED declaration — 재전송 = backlog).
  it('transmits a 수출신고 (REJECTED) — terminal, no MRN/수리일, 사유 logged, no journal, re-send 409s', async () => {
    const edId = await newExportDeclaration();

    const journalsBefore = await journalCount();
    const res = await unipass.submit(
      'EXPORT',
      edId,
      { result: 'REJECTED', responseMessage: 'HS 분류 오류 — 반려' },
      'tester',
    );

    expect(res).toMatchObject({
      declarationType: 'EXPORT',
      status: 'REJECTED',
      result: 'REJECTED',
      mrn: null,
    });
    expect(await journalCount()).toBe(journalsBefore);

    const full = await exportDeclarations.getExportDeclaration(edId);
    expect(full.status).toBe('REJECTED');
    expect(full.declarationNo).toBeNull(); // no MRN on 반려
    expect(full.acceptanceDate).toBeNull(); // no 수리일 on 반려

    const messages = await unipass.getMessages('EXPORT', edId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      result: 'REJECTED',
      mrn: null,
      responseMessage: 'HS 분류 오류 — 반려',
    });

    // REJECTED is terminal — a re-transmit of the rejected declaration 409s (재전송/정정 is backlog).
    await expect(unipass.submit('EXPORT', edId, {})).rejects.toThrow(
      /only a SUBMITTED declaration can be transmitted/,
    );
  });

  // 4 — guards: an unknown declaration (per type) → 404; an invalid declarationType → 400.
  it('rejects an unknown declaration (404) and an invalid declarationType (400)', async () => {
    await expect(unipass.submit('EXPORT', randomUUID(), {})).rejects.toThrow(
      /export declaration .* not found/,
    );
    await expect(unipass.submit('IMPORT', randomUUID(), {})).rejects.toThrow(
      /import declaration .* not found/,
    );
    await expect(unipass.submit('FOREIGN', randomUUID(), {})).rejects.toThrow(
      /declarationType must be EXPORT or IMPORT/,
    );
    await expect(unipass.getMessages('EXPORT', randomUUID())).rejects.toThrow(
      /export declaration .* not found/,
    );
  });
});
