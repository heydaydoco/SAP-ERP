import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { Money } from '@erp/kernel';
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
import { InventoryReconciliationService } from '../../src/domains/inventory-warehouse/inventory/reconciliation.service.js';
import { GoodsMovementService } from '../../src/domains/inventory-warehouse/goods-movement/goods-movement.service.js';
import { ProcurementQueryService } from '../../src/domains/procurement/procurement-query.service.js';
import { PurchaseOrderService } from '../../src/domains/procurement/purchase-order/purchase-order.service.js';
import { GoodsReceiptService } from '../../src/domains/procurement/goods-receipt/goods-receipt.service.js';
import { LandedCostService } from '../../src/domains/procurement/landed-cost/landed-cost.service.js';
import { SalesQueryService } from '../../src/domains/sales/sales-query.service.js';
import { SalesOrderService } from '../../src/domains/sales/sales-order/sales-order.service.js';
import { DeliveryService } from '../../src/domains/sales/delivery/delivery.service.js';
import { BillingService } from '../../src/domains/sales/billing/billing.service.js';

/**
 * O2C (SO → Delivery/GI → Billing) integration over a real PostgreSQL 16 (Testcontainers, §5.4). Proves
 * the slice end-to-end: a sales GI posts **Dr COGS / Cr BSX** at the current MAP (Σ COGS == Σ BSX ==
 * stock_value, holding through a partial GI + a landed-cost revaluation interleave, recon delta 0); a
 * billing bills only delivered qty (billed ≤ delivered, over-billing rejected); the engine rejects a
 * sloc shortfall even with stock elsewhere in the plant; replay is idempotent (DELIVERS not double
 * counted); two partial export billings each translate AR at their OWN document-date rate with NO
 * realized FX; an export zero-rate (V00) billing drops its VAT line; and an EXP+taxable SO warns while a
 * DOM+V00 SO passes clean.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('sales O2C (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let journals: JournalService;
  let movements: GoodsMovementService;
  let purchaseOrders: PurchaseOrderService;
  let goodsReceipts: GoodsReceiptService;
  let landedCosts: LandedCostService;
  let salesOrders: SalesOrderService;
  let deliveries: DeliveryService;
  let billings: BillingService;
  let salesQuery: SalesQueryService;
  let recon: InventoryReconciliationService;
  let registry: DbCurrencyRegistry;

  let companyCodeId: string;
  let plantId: string;
  let slocA: string;
  let slocB: string;
  let customerBpId: string;
  let vendorBpId: string;

  /** Σdebit − Σcredit (functional, KRW minor units) on a GL account for the company. */
  const glBalance = async (account: string): Promise<bigint> => {
    const rows = await db
      .select({
        drCr: schema.journalLine.drCr,
        functionalAmount: schema.journalLine.functionalAmount,
      })
      .from(schema.journalLine)
      .innerJoin(schema.journalEntry, eq(schema.journalLine.journalEntryId, schema.journalEntry.id))
      .where(
        and(
          eq(schema.journalEntry.companyCodeId, companyCodeId),
          eq(schema.journalLine.glAccount, account),
        ),
      );
    let net = 0n;
    for (const r of rows) {
      const minor = Money.fromNumeric(r.functionalAmount, 'KRW', registry).minorUnits;
      net += r.drCr === 'D' ? minor : -minor;
    }
    return net;
  };

  const expectDelta0 = async () => {
    const rows = await recon.reconcile(companyCodeId);
    for (const row of rows) expect(row.delta).toBe('0.0000');
  };

  /** Stock a material at a storage location via a priced 561 initial load (Dr BSX / Cr GBB). */
  const load561 = (materialId: string, storageLocationId: string, qty: string, price: string) =>
    movements.post({
      plantId,
      movementType: '561',
      postingDate: '2026-03-01',
      items: [{ materialId, storageLocationId, qty, unitPrice: price }],
    });

  let matSeq = 0;
  const newMaterial = async (storageLocationId: string, qty: string, price: string) => {
    matSeq += 1;
    const id = await new MaterialService(db).ensureMaterial({
      code: `SLS-${matSeq}`,
      name: `Sales material ${matSeq}`,
      materialType: 'FINISHED',
      baseUom: 'EA',
    });
    await new MaterialValuationService(db).ensureValuation({
      materialId: id,
      plantId,
      valuationClass: '3000',
    });
    if (Number(qty) > 0) await load561(id, storageLocationId, qty, price);
    return id;
  };

  const createSo = (
    items: { materialId: string; storageLocationId: string; orderedQty: string; unitPrice: string; taxCode?: string }[],
    opts: { currency?: string; tradeDirection?: 'EXP' | 'DOM' | 'IMP' } = {},
  ) =>
    salesOrders.create({
      companyCodeId,
      customerBpId,
      currency: opts.currency ?? 'KRW',
      orderDate: '2026-03-02',
      tradeDirection: opts.tradeDirection,
      items: items.map((i) => ({ ...i, plantId })),
    });

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 5 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    const org = new OrgStructureService(db);
    const fiscal = new FiscalPeriodService(db);
    const numbering = new NumberingService(db);
    const glAccounts = new GlAccountService(db);
    registry = new DbCurrencyRegistry(db);
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
    const valuations = new MaterialValuationService(db);
    recon = new InventoryReconciliationService(db, registry);
    movements = new GoodsMovementService(db, fiscal, numbering, docFlow, journals, accountDet, registry);
    const procQuery = new ProcurementQueryService(db);
    purchaseOrders = new PurchaseOrderService(db, partners, numbering);
    goodsReceipts = new GoodsReceiptService(db, movements, procQuery, currencies, registry);
    landedCosts = new LandedCostService(
      db,
      movements,
      partners,
      numbering,
      docFlow,
      accountDet,
      procQuery,
      registry,
      currencies,
    );
    salesQuery = new SalesQueryService(db);
    salesOrders = new SalesOrderService(db, partners, numbering);
    deliveries = new DeliveryService(db, movements, salesQuery);
    billings = new BillingService(db, journals, partners, numbering, docFlow, salesQuery, registry);

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
    // USD→KRW 'M' rates: billing date 2026-03-05 → 1300, 2026-03-12 → 1200 (resolveRate: latest ≤ date).
    for (const fx of [
      { validFrom: '2026-03-01', rate: '1300.000000' },
      { validFrom: '2026-03-10', rate: '1200.000000' },
    ]) {
      await currencies.ensureFxRate({ fromCurrency: 'USD', toCurrency: 'KRW', rateType: 'M', ...fx });
    }

    for (const range of [
      { object: 'finance.journal_entry', scope: '2026', prefix: 'JE-2026-' },
      { object: 'finance.ar_invoice', scope: '2026', prefix: 'DR-2026-' },
      { object: 'finance.ap_invoice', scope: '2026', prefix: 'KR-2026-' },
      { object: 'inventory.goods_movement', scope: '2026', prefix: 'GM-2026-' },
      { object: 'procurement.purchase_order', prefix: 'PO-' },
      { object: 'procurement.landed_cost', prefix: 'LC-' },
      { object: 'sales.sales_order', prefix: 'SO-' },
      { object: 'sales.billing', prefix: 'BL-' },
    ]) {
      await numbering.defineRange({ padding: 6, ...range });
    }

    for (const acc of [
      { accountNumber: '1100', name: '외상매출금', accountType: 'ASSET' as const, isReconciliation: true },
      { accountNumber: '1300', name: '원재료', accountType: 'ASSET' as const },
      { accountNumber: '2100', name: '외상매입금', accountType: 'LIABILITY' as const, isReconciliation: true },
      { accountNumber: '2110', name: '입고미착', accountType: 'LIABILITY' as const },
      { accountNumber: '2550', name: '부가세예수금', accountType: 'LIABILITY' as const },
      { accountNumber: '4000', name: '제품매출', accountType: 'REVENUE' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
      { accountNumber: '5200', name: '매출원가', accountType: 'EXPENSE' as const },
      { accountNumber: '5900', name: '재고원가차이', accountType: 'EXPENSE' as const },
      { accountNumber: '9800', name: '외환차손익', accountType: 'EXPENSE' as const },
      // Realized-FX accounts: NOT touched by billing (realized FX is clearing-only) — seeded so the
      // "no realized FX at billing" assertions are load-bearing (a regression wiring them in would post here).
      { accountNumber: '9810', name: '외환차익', accountType: 'REVENUE' as const },
      { accountNumber: '9820', name: '외환차손', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }
    for (const rule of [
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' },
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' },
      { transactionKey: 'WRX', glAccount: '2110' },
      { transactionKey: 'COGS', glAccount: '5200' }, // single wildcard — the sales-GI offset
      { transactionKey: 'PRD', glAccount: '5900' },
      { transactionKey: 'FX_ROUNDING', glAccount: '9800' },
      { transactionKey: 'REALIZED_FX_GAIN', glAccount: '9810' },
      { transactionKey: 'REALIZED_FX_LOSS', glAccount: '9820' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocA = await org.ensureStorageLocation({ code: '0001', name: 'Main A', plantId });
    slocB = await org.ensureStorageLocation({ code: '0002', name: 'Main B', plantId });

    customerBpId = await partners.ensureBp({
      code: 'C-CUST',
      name: 'Acme Retail',
      bpType: 'ORGANIZATION',
      country: 'KR',
    });
    await partners.ensureCustomerRole(customerBpId, {
      arReconAccount: '1100',
      paymentTermsDays: 30,
      salesBlock: false,
    });
    vendorBpId = await partners.ensureBp({
      code: 'V-SUP',
      name: 'Supplier / Forwarder',
      bpType: 'ORGANIZATION',
      country: 'KR',
    });
    await partners.ensureVendorRole(vendorBpId, {
      apReconAccount: '2100',
      paymentTermsDays: 30,
      purchasingBlock: false,
    });

    const taxCodes = new TaxCodeService(db);
    await taxCodes.ensureTaxCode({ code: 'V10', name: '매출 부가세 10%', kind: 'OUTPUT', ratePercent: '10', glAccount: '2550' });
    await taxCodes.ensureTaxCode({ code: 'V00', name: '매출 영세율', kind: 'OUTPUT', ratePercent: '0', glAccount: '2550' });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — GI Dr COGS / Cr BSX at MAP; Σ COGS == Σ BSX == stock_value across a partial GI + landed-cost interleave.
  it('recognizes COGS at MAP and stays reconciled across a partial GI + landed-cost interleave', async () => {
    const cogsBefore = await glBalance('5200');

    // Stock 10 @ ₩100 via a PO + GR (so there is a PO for the landed cost to capitalize onto). MAP 100.
    const matId = await new MaterialService(db).ensureMaterial({
      code: 'SLS-COGS',
      name: 'COGS material',
      materialType: 'RAW',
      baseUom: 'KG',
    });
    await new MaterialValuationService(db).ensureValuation({ materialId: matId, plantId, valuationClass: '3000' });
    const po = await purchaseOrders.create({
      companyCodeId,
      vendorBpId,
      currency: 'KRW',
      orderDate: '2026-03-01',
      items: [{ materialId: matId, plantId, storageLocationId: slocA, orderedQty: '10', unitPrice: '100' }],
    });
    const poFull = await purchaseOrders.getPurchaseOrder(po.purchaseOrderId);
    await goodsReceipts.post({
      purchaseOrderId: po.purchaseOrderId,
      postingDate: '2026-03-02',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: poFull.items[0]!.id, qty: '10' }],
    });
    await expectDelta0();

    const so = await createSo([
      { materialId: matId, storageLocationId: slocA, orderedQty: '10', unitPrice: '250', taxCode: 'V10' },
    ]);
    const soFull = await salesOrders.getSalesOrder(so.salesOrderId);
    const soItemId = soFull.items[0]!.id;

    // Partial GI: 4 units at MAP 100 → COGS ₩400. Dr COGS 5200 / Cr BSX 1300, both ₩400.
    const gi1 = await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-03',
      items: [{ salesOrderItemId: soItemId, qty: '4' }],
    });
    expect(gi1.totalCogs.toNumeric()).toBe('400.0000');
    expect(gi1.perItemCogs[0]!.amount.toNumeric()).toBe('400.0000');
    const gi1Entry = await journals.getJournal(gi1.journalId!);
    expect(gi1Entry.docType).toBe('WA');
    expect(gi1Entry.lines.find((l) => l.glAccount === '5200')).toMatchObject({ drCr: 'D', amount: '400.0000' });
    expect(gi1Entry.lines.find((l) => l.glAccount === '1300')).toMatchObject({ drCr: 'C', amount: '400.0000' });
    await expectDelta0();

    // Landed cost ₩300 onto the PO (6 of 10 on hand): covered 180 → Dr BSX, uncovered 120 → Dr PRD.
    // stock_value 600 → 780, MAP 130. BSX rose by 180 so recon stays 0.
    const lc = await landedCosts.post({
      companyCodeId,
      purchaseOrderId: po.purchaseOrderId,
      vendorBpId,
      reference: 'FWD-1',
      postingDate: '2026-03-04',
      documentDate: '2026-03-04',
      currency: 'KRW',
      costAmount: '300',
    });
    const lcEntry = await journals.getJournal(lc.journalId);
    expect(lcEntry.lines.find((l) => l.glAccount === '1300')).toMatchObject({ drCr: 'D', amount: '180.0000' });
    expect(lcEntry.lines.find((l) => l.glAccount === '5900')).toMatchObject({ drCr: 'D', amount: '120.0000' });
    await expectDelta0();

    // GI the remaining 6 at the NEW MAP 130 → COGS ₩780 (empties stock_value to 0).
    const gi2 = await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-05',
      items: [{ salesOrderItemId: soItemId, qty: '6' }],
    });
    expect(gi2.totalCogs.toNumeric()).toBe('780.0000');
    const gi2Entry = await journals.getJournal(gi2.journalId!);
    expect(gi2Entry.lines.find((l) => l.glAccount === '5200')).toMatchObject({ drCr: 'D', amount: '780.0000' });
    expect(gi2Entry.lines.find((l) => l.glAccount === '1300')).toMatchObject({ drCr: 'C', amount: '780.0000' });
    await expectDelta0();

    // Σ COGS = 400 + 780 = 1180 = stocked 1000 (GR) + capitalized 180 (landed cost), all consumed.
    expect((await glBalance('5200')) - cogsBefore).toBe(1180n);
  });

  // 2 — billing bills only delivered qty: billed ≤ delivered, over-billing is rejected.
  it('bills only delivered quantity and rejects over-billing', async () => {
    const matId = await newMaterial(slocA, '20', '100');
    const so = await createSo([
      { materialId: matId, storageLocationId: slocA, orderedQty: '10', unitPrice: '250', taxCode: 'V10' },
    ]);
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;

    await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-06',
      items: [{ salesOrderItemId: soItemId, qty: '6' }],
    });

    // Bill 4 of the 6 delivered — allowed. Gross = 4 × 250 × 1.1 = ₩1,100.
    const bill = await billings.post({
      companyCodeId,
      salesOrderId: so.salesOrderId,
      reference: 'INV-OB-1',
      postingDate: '2026-03-07',
      documentDate: '2026-03-07',
      currency: 'KRW',
      items: [{ salesOrderItemId: soItemId, qty: '4', revenueAccount: '4000' }],
    });
    expect(bill.totalNet).toBe('1000.0000');
    expect(bill.totalTax).toBe('100.0000');
    expect(bill.grandTotal).toBe('1100.0000');

    const delivered = (await salesQuery.deliveredBySoItem([soItemId])).get(soItemId)!.qty6;
    const billed = (await salesQuery.billedBySoItem([soItemId])).get(soItemId)!.qty6;
    expect(billed <= delivered).toBe(true);

    // Billing 3 more would be 7 > 6 delivered → rejected.
    await expect(
      billings.post({
        companyCodeId,
        salesOrderId: so.salesOrderId,
        reference: 'INV-OB-2',
        postingDate: '2026-03-07',
        documentDate: '2026-03-07',
        currency: 'KRW',
        items: [{ salesOrderItemId: soItemId, qty: '3', revenueAccount: '4000' }],
      }),
    ).rejects.toThrow(/over-billing|open-to-bill/);
    await expectDelta0();
  });

  // 3 — sloc shortfall: a GI from an empty storage location is rejected even with stock elsewhere in the plant.
  it('rejects a goods issue from a storage location that is short, despite plant stock elsewhere', async () => {
    // Stock the material ONLY at sloc A; the SO line issues from sloc B (empty).
    const matId = await newMaterial(slocA, '10', '100');
    const so = await createSo([
      { materialId: matId, storageLocationId: slocB, orderedQty: '5', unitPrice: '250' },
    ]);
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;

    await expect(
      deliveries.post({
        salesOrderId: so.salesOrderId,
        postingDate: '2026-03-06',
        items: [{ salesOrderItemId: soItemId, qty: '1' }],
      }),
    ).rejects.toThrow(/over-issue|on stock at the storage location/);
    await expectDelta0();
  });

  // 4 — replay idempotency: a replayed delivery returns the same movement and does NOT double-count DELIVERS.
  it('is idempotent on a replayed delivery posting key (DELIVERS not double counted)', async () => {
    const matId = await newMaterial(slocA, '10', '100');
    const so = await createSo([
      { materialId: matId, storageLocationId: slocA, orderedQty: '10', unitPrice: '250' },
    ]);
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;

    const key = `dlv:${so.salesOrderId}`;
    const first = await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-06',
      postingKey: key,
      items: [{ salesOrderItemId: soItemId, qty: '4' }],
    });
    const replay = await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-06',
      postingKey: key,
      items: [{ salesOrderItemId: soItemId, qty: '4' }],
    });
    expect(replay.goodsMovementId).toBe(first.goodsMovementId);
    // Delivered stays 4 (the replay did not add a second 4) — the DELIVERS edges are not double counted.
    expect((await salesQuery.deliveredBySoItem([soItemId])).get(soItemId)!.qty6).toBe(4_000000n);
    await expectDelta0();
  });

  // 5 — two partial EXPORT billings at DIFFERENT document-date rates; AR at each own rate; NO realized FX.
  it('translates two partial export billings each at its own document-date rate (no realized FX)', async () => {
    const matId = await newMaterial(slocA, '10', '100');
    const so = await createSo(
      [{ materialId: matId, storageLocationId: slocA, orderedQty: '10', unitPrice: '100', taxCode: 'V00' }],
      { currency: 'USD', tradeDirection: 'EXP' },
    );
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;
    await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-04',
      items: [{ salesOrderItemId: soItemId, qty: '10' }],
    });

    // Billing 1 on 2026-03-05 → USD rate 1300. Net $500 → AR functional ₩650,000.
    const b1 = await billings.post({
      companyCodeId,
      salesOrderId: so.salesOrderId,
      reference: 'EXP-1',
      postingDate: '2026-03-05',
      documentDate: '2026-03-05',
      currency: 'USD',
      items: [{ salesOrderItemId: soItemId, qty: '5', revenueAccount: '4000' }],
    });
    const e1 = await journals.getJournal(b1.journalId);
    expect(e1.docType).toBe('DR');
    expect(e1.currency).toBe('USD');
    expect(e1.fxRate).toBe('1300.000000');
    expect(e1.lines.find((l) => l.glAccount === '1100')).toMatchObject({
      drCr: 'D',
      amount: '500.0000',
      functionalAmount: '650000.0000',
      partnerId: customerBpId,
    });
    expect(e1.lines.find((l) => l.glAccount === '9810')).toBeUndefined();
    expect(e1.lines.find((l) => l.glAccount === '9820')).toBeUndefined();
    expect(e1.lines.find((l) => l.glAccount === '2550')).toBeUndefined(); // zero-rated → no VAT line

    // Billing 2 on 2026-03-12 → USD rate 1200. Net $500 → AR functional ₩600,000 (its OWN rate).
    const b2 = await billings.post({
      companyCodeId,
      salesOrderId: so.salesOrderId,
      reference: 'EXP-2',
      postingDate: '2026-03-12',
      documentDate: '2026-03-12',
      currency: 'USD',
      items: [{ salesOrderItemId: soItemId, qty: '5', revenueAccount: '4000' }],
    });
    const e2 = await journals.getJournal(b2.journalId);
    expect(e2.fxRate).toBe('1200.000000');
    expect(e2.lines.find((l) => l.glAccount === '1100')).toMatchObject({
      drCr: 'D',
      amount: '500.0000',
      functionalAmount: '600000.0000',
    });
    expect(e2.lines.find((l) => l.glAccount === '9810')).toBeUndefined();
    expect(e2.lines.find((l) => l.glAccount === '9820')).toBeUndefined();
    await expectDelta0();
  });

  // 6 — export zero-rate (V00): the billing posts no VAT line and AR equals revenue.
  it('drops the VAT line on an export zero-rate (V00) billing', async () => {
    const matId = await newMaterial(slocA, '5', '100');
    const so = await createSo(
      [{ materialId: matId, storageLocationId: slocA, orderedQty: '5', unitPrice: '300', taxCode: 'V00' }],
      { tradeDirection: 'EXP' },
    );
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;
    await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-06',
      items: [{ salesOrderItemId: soItemId, qty: '5' }],
    });

    const bill = await billings.post({
      companyCodeId,
      salesOrderId: so.salesOrderId,
      reference: 'ZR-1',
      postingDate: '2026-03-07',
      documentDate: '2026-03-07',
      currency: 'KRW',
      items: [{ salesOrderItemId: soItemId, qty: '5', revenueAccount: '4000' }],
    });
    expect(bill.totalNet).toBe('1500.0000');
    expect(bill.totalTax).toBe('0.0000');
    expect(bill.grandTotal).toBe('1500.0000');
    const entry = await journals.getJournal(bill.journalId);
    expect(entry.lines.find((l) => l.glAccount === '2550')).toBeUndefined(); // no output VAT line
    expect(entry.lines.find((l) => l.glAccount === '1100')).toMatchObject({ drCr: 'D', amount: '1500.0000' });
    expect(entry.lines.find((l) => l.glAccount === '4000')).toMatchObject({ drCr: 'C', amount: '1500.0000' });
    await expectDelta0();
  });

  // 7 — EXP + a taxable code raises a SOFT warning; DOM + V00 passes clean (never blocked).
  it('warns on EXP + a taxable code but passes DOM + V00 clean', async () => {
    const matId = await newMaterial(slocA, '0', '0'); // no stock needed — SO create only

    const exp = await createSo(
      [{ materialId: matId, storageLocationId: slocA, orderedQty: '1', unitPrice: '100', taxCode: 'V10' }],
      { tradeDirection: 'EXP' },
    );
    expect(exp.warnings.length).toBeGreaterThan(0);
    expect(exp.warnings[0]).toContain('line 1');

    const dom = await createSo(
      [{ materialId: matId, storageLocationId: slocA, orderedQty: '1', unitPrice: '100', taxCode: 'V00' }],
      { tradeDirection: 'DOM' },
    );
    expect(dom.warnings).toEqual([]);
    expect(dom.status).toBe('ORDERED');
  });

  // 8 — billing is FI-reversible (no POSTS edge): reversing a billing re-opens its billed quantity.
  it('re-opens the billed quantity when a billing journal is reversed', async () => {
    const matId = await newMaterial(slocA, '10', '100');
    const so = await createSo([
      { materialId: matId, storageLocationId: slocA, orderedQty: '10', unitPrice: '250', taxCode: 'V10' },
    ]);
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;
    await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-06',
      items: [{ salesOrderItemId: soItemId, qty: '6' }],
    });

    const bill = await billings.post({
      companyCodeId,
      salesOrderId: so.salesOrderId,
      reference: 'REV-1',
      postingDate: '2026-03-07',
      documentDate: '2026-03-07',
      currency: 'KRW',
      items: [{ salesOrderItemId: soItemId, qty: '4', revenueAccount: '4000' }],
    });
    expect((await salesQuery.billedBySoItem([soItemId])).get(soItemId)!.qty6).toBe(4_000000n);

    // Reverse the billing journal — ALLOWED because billing writes no POSTS edge (unlike a GI/IV journal).
    const reversal = await journals.reverse(bill.journalId, 'test reversal', '2026-03-08');
    expect(reversal.status).toBe('POSTED');

    // Reversal-aware billedBySoItem drops the reversed billing → the quantity re-opens to the full 6.
    expect((await salesQuery.billedBySoItem([soItemId])).get(soItemId)).toBeUndefined();
    const o2c = await salesQuery.o2cBySalesOrder(so.salesOrderId);
    expect(o2c.lines[0]!.openToBillQty).toBe('6.000000');

    // The re-opened quantity is billable again (fresh reference); over-billing past 6 still rejects.
    const rebill = await billings.post({
      companyCodeId,
      salesOrderId: so.salesOrderId,
      reference: 'REV-2',
      postingDate: '2026-03-09',
      documentDate: '2026-03-09',
      currency: 'KRW',
      items: [{ salesOrderItemId: soItemId, qty: '4', revenueAccount: '4000' }],
    });
    expect(rebill.status).toBe('POSTED');
    await expect(
      billings.post({
        companyCodeId,
        salesOrderId: so.salesOrderId,
        reference: 'REV-3',
        postingDate: '2026-03-09',
        documentDate: '2026-03-09',
        currency: 'KRW',
        items: [{ salesOrderItemId: soItemId, qty: '3', revenueAccount: '4000' }],
      }),
    ).rejects.toThrow(/over-billing|open-to-bill/);
    await expectDelta0();
  });
});
