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

/**
 * Landed-cost + import-VAT integration over a real PostgreSQL 16 (Testcontainers, §5.4). Proves the
 * slice end-to-end on top of the import P2P: a posted GR's stock is revalued by incidental costs via
 * the value-only sibling (Dr BSX covered / Dr PRD uncovered / Dr 부가세대급금 import VAT / Cr AP recon),
 * with the load-bearing invariants holding throughout:
 *   ① Σ stock_value rises by exactly the COVERED total · ② BSX rises by the same · ③ recon delta 0
 *   after every step · ④ import VAT lands in 1350, NOT in stock_value/BSX · ⑤ a foreign cost invoice
 *   balances in BOTH currencies (residue → 9810/9820, FX_ROUNDING 9800 never fires) · ⑥ fully-issued
 *   stock routes the whole share to PRD (BSX untouched, no empty_zero violation), partial issue splits,
 *   full on-hand capitalizes wholly · ⑦ idempotent replay.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('landed cost + import VAT (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let journals: JournalService;
  let movements: GoodsMovementService;
  let purchaseOrders: PurchaseOrderService;
  let goodsReceipts: GoodsReceiptService;
  let landedCosts: LandedCostService;
  let query: ProcurementQueryService;
  let recon: InventoryReconciliationService;
  let materials: MaterialService;
  let valuations: MaterialValuationService;
  let registry: DbCurrencyRegistry;

  let companyCodeId: string;
  let plantId: string;
  let slocId: string;
  let vendorBpId: string;
  let materialSeq = 0;

  /** Σdebit − Σcredit (functional, KRW minor units) on a GL account for the company. */
  const glBalance = async (account: string): Promise<bigint> => {
    const rows = await db
      .select({ drCr: schema.journalLine.drCr, functionalAmount: schema.journalLine.functionalAmount })
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

  /** stock_value of a (material, plant) in functional (KRW) minor units. */
  const stockVal = async (materialId: string): Promise<bigint> => {
    const [v] = await db
      .select()
      .from(schema.materialValuation)
      .where(
        and(
          eq(schema.materialValuation.materialId, materialId),
          eq(schema.materialValuation.plantId, plantId),
        ),
      );
    return Money.fromNumeric(v!.stockValue, 'KRW', registry).minorUnits;
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
    registry = new DbCurrencyRegistry(db);
    const currencies = new CurrencyService(db, registry);
    const accountDet = new AccountDeterminationService(db);
    const docFlow = new DocFlowService(db);
    const partners = new BusinessPartnerService(db);
    materials = new MaterialService(db);
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
    valuations = new MaterialValuationService(db);
    recon = new InventoryReconciliationService(db, registry);
    movements = new GoodsMovementService(db, fiscal, numbering, docFlow, journals, accountDet, registry);
    query = new ProcurementQueryService(db);
    purchaseOrders = new PurchaseOrderService(db, partners, numbering);
    goodsReceipts = new GoodsReceiptService(db, movements, query, currencies, registry);
    landedCosts = new LandedCostService(
      db,
      movements,
      partners,
      numbering,
      docFlow,
      accountDet,
      query,
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
    companyCodeId = company.id;
    await fiscal.generateYear(companyCodeId, 2026);
    await currencies.ensureCurrency({ code: 'KRW', name: 'South Korean Won', minorUnit: 0 });
    await currencies.ensureCurrency({ code: 'USD', name: 'US Dollar', minorUnit: 2 });
    // USD→KRW 'M' rates: GR date (03-06 → 1300), landed-cost date (03-12 → 1350).
    for (const fx of [
      { validFrom: '2026-03-01', rate: '1300.000000' },
      { validFrom: '2026-03-11', rate: '1350.000000' },
    ]) {
      await currencies.ensureFxRate({ fromCurrency: 'USD', toCurrency: 'KRW', rateType: 'M', ...fx });
    }

    for (const range of [
      { object: 'finance.journal_entry', scope: '2026', prefix: 'JE-2026-' },
      { object: 'finance.ap_invoice', scope: '2026', prefix: 'KR-2026-' },
      { object: 'inventory.goods_movement', scope: '2026', prefix: 'GM-2026-' },
      { object: 'procurement.purchase_order', prefix: 'PO-' },
      { object: 'procurement.landed_cost', prefix: 'LC-' },
    ]) {
      await numbering.defineRange({ padding: 6, ...range });
    }

    for (const acc of [
      { accountNumber: '1300', name: '원재료', accountType: 'ASSET' as const },
      { accountNumber: '1350', name: '부가세대급금', accountType: 'ASSET' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
      { accountNumber: '5900', name: '재고원가차이', accountType: 'EXPENSE' as const },
      {
        accountNumber: '2100',
        name: '외상매입금',
        accountType: 'LIABILITY' as const,
        isReconciliation: true,
      },
      { accountNumber: '2110', name: '입고미착', accountType: 'LIABILITY' as const },
      // FX accounts — currency null (omitted) so a 0-amount foreign line is never rejected.
      { accountNumber: '9800', name: '외환차손익', accountType: 'EXPENSE' as const },
      { accountNumber: '9810', name: '외환차익', accountType: 'REVENUE' as const },
      { accountNumber: '9820', name: '외환차손', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }
    for (const rule of [
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' },
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' },
      { transactionKey: 'WRX', glAccount: '2110' },
      { transactionKey: 'PRD', glAccount: '5900' },
      { transactionKey: 'FX_ROUNDING', glAccount: '9800' },
      { transactionKey: 'REALIZED_FX_GAIN', glAccount: '9810' },
      { transactionKey: 'REALIZED_FX_LOSS', glAccount: '9820' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }
    const taxCodes = new TaxCodeService(db);
    await taxCodes.ensureTaxCode({
      code: 'I10',
      name: '수입 부가세',
      kind: 'INPUT',
      ratePercent: '10',
      glAccount: '1350',
    });

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocId = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId });

    // One business partner plays the goods supplier AND the forwarder/관세사 (AP recon 2100). The
    // landed-cost AP currency follows the cost-invoice document, not the BP.
    vendorBpId = await partners.ensureBp({
      code: 'V9000',
      name: 'Global Freight & Customs Co.',
      bpType: 'ORGANIZATION',
      country: 'KR',
      city: 'Seoul',
    });
    await partners.ensureVendorRole(vendorBpId, {
      apReconAccount: '2100',
      paymentTermsDays: 30,
      purchasingBlock: false,
    });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  /** A fresh raw material + its (empty) valuation row at the plant — isolates each scenario's stock. */
  const makeMaterial = async (): Promise<string> => {
    materialSeq += 1;
    const id = await materials.ensureMaterial({
      code: `RM-LC-${materialSeq}`,
      name: `Imported Material ${materialSeq}`,
      materialType: 'RAW',
      baseUom: 'KG',
    });
    await valuations.ensureValuation({ materialId: id, plantId, valuationClass: '3000' });
    return id;
  };

  /** Create a single-line PO (currency-agnostic) and return its id + the line item id. */
  const createPo = async (materialId: string, qty: string, price: string, currency: string) => {
    const po = await purchaseOrders.create({
      companyCodeId,
      vendorBpId,
      currency,
      orderDate: '2026-03-01',
      items: [{ materialId, plantId, storageLocationId: slocId, orderedQty: qty, unitPrice: price }],
    });
    const full = await purchaseOrders.getPurchaseOrder(po.purchaseOrderId);
    return { id: po.purchaseOrderId, itemId: full.items[0]!.id, docNo: po.docNo };
  };

  const receive = (po: { id: string; itemId: string; docNo: string }, qty: string) =>
    goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, qty }],
    });

  /** Direct goods issue (movement 201, Dr GBB / Cr BSX at MAP) — to set up partial/full prior issue. */
  const issue = (materialId: string, qty: string) =>
    movements.post({
      plantId,
      movementType: '201',
      postingDate: '2026-03-08',
      postingKey: `wa:${materialId}:${qty}`,
      items: [{ materialId, storageLocationId: slocId, qty }],
    });

  // ① ② ③ ④ ⑥(full on-hand) — domestic landed cost capitalizes the whole cost; import VAT → 1350.
  it('capitalizes a domestic landed cost onto fully-on-hand stock and books import VAT to 1350', async () => {
    const m = await makeMaterial();
    const po = await createPo(m, '100', '1000', 'KRW'); // ₩100,000 received
    await receive(po, '100');
    await expectDelta0();

    const stockBefore = await stockVal(m);
    const bsxBefore = await glBalance('1300');
    const vatBefore = await glBalance('1350');
    const prdBefore = await glBalance('5900');

    const lc = await landedCosts.post({
      companyCodeId,
      purchaseOrderId: po.id,
      vendorBpId,
      reference: 'CUSTOMS-1001',
      importDeclarationNo: '12345-67-8901234',
      postingDate: '2026-03-12',
      documentDate: '2026-03-12',
      currency: 'KRW',
      costAmount: '30000', // 관세 + 운임 + 통관수수료, all capitalized
      importVatAmount: '13000', // 수입세금계산서 VAT on (CIF + 관세), NOT capitalized
      vatTaxCode: 'I10',
      postingKey: `lc:${po.docNo}`,
    });
    expect(lc.docNo).toMatch(/^LC-000\d{3}$/);
    expect(lc.totalCovered).toBe('30000.0000');
    expect(lc.totalPrd).toBe('0.0000');
    expect(lc.importVatAmount).toBe('13000.0000');

    // ① stock_value rose by the full cost (30,000) — NOT including VAT.
    expect((await stockVal(m)) - stockBefore).toBe(30_000n);
    // ② BSX rose by the same; ④ VAT to 1350 only; PRD untouched.
    expect((await glBalance('1300')) - bsxBefore).toBe(30_000n);
    expect((await glBalance('1350')) - vatBefore).toBe(13_000n);
    expect((await glBalance('5900')) - prdBefore).toBe(0n);

    // The journal: Dr BSX 30,000 / Dr 부가세대급금 13,000 / Cr AP 43,000 (+forwarder partner).
    const entry = await journals.getJournal(lc.journalId);
    expect(entry.docType).toBe('KR');
    expect(entry.lines.find((l) => l.glAccount === '1300')).toMatchObject({
      drCr: 'D',
      amount: '30000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '1350')).toMatchObject({
      drCr: 'D',
      amount: '13000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '2100')).toMatchObject({
      drCr: 'C',
      amount: '43000.0000',
      partnerId: vendorBpId,
    });
    expect(entry.lines.find((l) => l.glAccount === '5900')).toBeUndefined();

    // MAP rose: (100,000 + 30,000) / 100 = 1,300; quantity unchanged.
    const [val] = await db
      .select()
      .from(schema.materialValuation)
      .where(
        and(
          eq(schema.materialValuation.materialId, m),
          eq(schema.materialValuation.plantId, plantId),
        ),
      );
    expect(val!.valuationQty).toBe('100.000000');
    expect(val!.movingAvgPrice).toBe('1300.000000');
    await expectDelta0();
  });

  // ⑥ fully-issued: the whole share goes to PRD, BSX/stock_value untouched (no empty_zero violation).
  it('routes the whole share to PRD when the stock was fully issued before the cost arrived', async () => {
    const m = await makeMaterial();
    const po = await createPo(m, '50', '1000', 'KRW');
    await receive(po, '50');
    await issue(m, '50'); // empty the stock: qty 0, value 0
    expect(await stockVal(m)).toBe(0n);
    await expectDelta0();

    const bsxBefore = await glBalance('1300');
    const prdBefore = await glBalance('5900');

    const lc = await landedCosts.post({
      companyCodeId,
      purchaseOrderId: po.id,
      vendorBpId,
      reference: 'CUSTOMS-1002',
      postingDate: '2026-03-12',
      documentDate: '2026-03-12',
      currency: 'KRW',
      costAmount: '10000',
      postingKey: `lc:${po.docNo}`,
    });
    expect(lc.totalCovered).toBe('0.0000');
    expect(lc.totalPrd).toBe('10000.0000');

    // stock_value still 0 (empty_zero respected); BSX untouched; the whole 10,000 hit PRD.
    expect(await stockVal(m)).toBe(0n);
    expect((await glBalance('1300')) - bsxBefore).toBe(0n);
    expect((await glBalance('5900')) - prdBefore).toBe(10_000n);

    const entry = await journals.getJournal(lc.journalId);
    expect(entry.lines.find((l) => l.glAccount === '1300')).toBeUndefined();
    expect(entry.lines.find((l) => l.glAccount === '5900')).toMatchObject({
      drCr: 'D',
      amount: '10000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '2100')).toMatchObject({
      drCr: 'C',
      amount: '10000.0000',
    });
    await expectDelta0();
  });

  // ⑥ partial issue: the covered share capitalizes, the issued share goes to PRD (conserves the total).
  it('splits the cost into covered (BSX) and uncovered (PRD) on a partial prior issue', async () => {
    const m = await makeMaterial();
    const po = await createPo(m, '100', '1000', 'KRW');
    await receive(po, '100'); // qty 100, value 100,000
    await issue(m, '60'); // qty 40 remains on hand (40% coverage of this PO line)
    const stockBefore = await stockVal(m); // 40,000
    const bsxBefore = await glBalance('1300');
    const prdBefore = await glBalance('5900');

    const lc = await landedCosts.post({
      companyCodeId,
      purchaseOrderId: po.id,
      vendorBpId,
      reference: 'CUSTOMS-1003',
      postingDate: '2026-03-12',
      documentDate: '2026-03-12',
      currency: 'KRW',
      costAmount: '10000',
      postingKey: `lc:${po.docNo}`,
    });
    // coverage = min(received 100, on-hand 40)/100 = 40% → covered 4,000 / PRD 6,000.
    expect(lc.totalCovered).toBe('4000.0000');
    expect(lc.totalPrd).toBe('6000.0000');

    expect((await stockVal(m)) - stockBefore).toBe(4_000n);
    expect((await glBalance('1300')) - bsxBefore).toBe(4_000n);
    expect((await glBalance('5900')) - prdBefore).toBe(6_000n);

    const entry = await journals.getJournal(lc.journalId);
    expect(entry.lines.find((l) => l.glAccount === '1300')).toMatchObject({ drCr: 'D', amount: '4000.0000' });
    expect(entry.lines.find((l) => l.glAccount === '5900')).toMatchObject({ drCr: 'D', amount: '6000.0000' });
    await expectDelta0();
  });

  // ⑤ foreign cost invoice (single line): balances in BOTH currencies; FX_ROUNDING (9800) never fires.
  it('capitalizes a foreign cost invoice in KRW with no FX_ROUNDING line', async () => {
    const m = await makeMaterial();
    const po = await createPo(m, '10', '100', 'USD'); // $1,000 — GR at 1300 → ₩1,300,000
    await receive(po, '10');
    const stockBefore = await stockVal(m);
    const bsxBefore = await glBalance('1300');

    const lc = await landedCosts.post({
      companyCodeId,
      purchaseOrderId: po.id,
      vendorBpId,
      reference: 'FWD-2001',
      postingDate: '2026-03-08', // USD rate 1300
      documentDate: '2026-03-08',
      currency: 'USD',
      costAmount: '50.00', // $50 freight → ₩65,000 at 1300
      postingKey: `lc:${po.docNo}`,
    });
    expect(lc.currency).toBe('USD');
    expect(lc.totalCovered).toBe('65000.0000'); // functional KRW capitalized
    expect(lc.totalPrd).toBe('0.0000');

    const entry = await journals.getJournal(lc.journalId);
    expect(entry.currency).toBe('USD');
    expect(entry.fxRate).toBe('1300.000000');
    // BSX line: document $50, functional ₩65,000.
    expect(entry.lines.find((l) => l.glAccount === '1300')).toMatchObject({
      drCr: 'D',
      amount: '50.0000',
      functionalAmount: '65000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '2100')).toMatchObject({
      drCr: 'C',
      amount: '50.0000',
      functionalAmount: '65000.0000',
      partnerId: vendorBpId,
    });
    // No FX_ROUNDING plug, and a single-line/single-rate entry has no realized-FX residue.
    expect(entry.lines.find((l) => l.glAccount === '9800')).toBeUndefined();
    expect(entry.lines.find((l) => l.glAccount === '9810')).toBeUndefined();
    expect(entry.lines.find((l) => l.glAccount === '9820')).toBeUndefined();

    expect((await stockVal(m)) - stockBefore).toBe(65_000n);
    expect((await glBalance('1300')) - bsxBefore).toBe(65_000n);
    await expectDelta0();
  });

  // ⑤ foreign cost invoice (two lines): per-line translation residue → realized FX (9810), NOT 9800.
  it('routes the foreign per-line translation residue to realized FX (9810), not FX_ROUNDING', async () => {
    const mX = await makeMaterial();
    const mY = await makeMaterial();
    // One USD PO, two lines with received-value ratio 1:2 (qty 10 vs 20 @ $10) → allocation 3333:6667¢.
    const po = await purchaseOrders.create({
      companyCodeId,
      vendorBpId,
      currency: 'USD',
      orderDate: '2026-03-01',
      items: [
        { materialId: mX, plantId, storageLocationId: slocId, orderedQty: '10', unitPrice: '10' },
        { materialId: mY, plantId, storageLocationId: slocId, orderedQty: '20', unitPrice: '10' },
      ],
    });
    const full = await purchaseOrders.getPurchaseOrder(po.purchaseOrderId);
    const itemX = full.items.find((i) => i.materialId === mX)!.id;
    const itemY = full.items.find((i) => i.materialId === mY)!.id;
    await goodsReceipts.post({
      purchaseOrderId: po.purchaseOrderId,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [
        { purchaseOrderItemId: itemX, qty: '10' },
        { purchaseOrderItemId: itemY, qty: '20' },
      ],
    });
    const sxBefore = await stockVal(mX);
    const syBefore = await stockVal(mY);
    const fxRoundBefore = await glBalance('9800');

    // $100 freight at rate 1350. Shares $33.33 / $66.67 → ₩44,996 + ₩90,005 = ₩135,001 capitalized;
    // AP $100 → ₩135,000; residue +₩1 → realized FX GAIN (9810), credit.
    const lc = await landedCosts.post({
      companyCodeId,
      purchaseOrderId: po.purchaseOrderId,
      vendorBpId,
      reference: 'FWD-2002',
      postingDate: '2026-03-12', // USD rate 1350
      documentDate: '2026-03-12',
      currency: 'USD',
      costAmount: '100.00',
      postingKey: `lc:${po.docNo}`,
    });

    const entry = await journals.getJournal(lc.journalId);
    expect(entry.fxRate).toBe('1350.000000');
    // FX_ROUNDING (9800) must NOT fire — every line carries its functional amount.
    expect(entry.lines.find((l) => l.glAccount === '9800')).toBeUndefined();
    expect((await glBalance('9800')) - fxRoundBefore).toBe(0n);
    // The per-line translation residue posts to realized FX 9810 (0 in the document currency).
    const fx = entry.lines.find((l) => l.glAccount === '9810' || l.glAccount === '9820')!;
    expect(fx).toBeDefined();
    expect(fx.amount).toBe('0.0000');

    // ① ② capitalized functional == stock_value delta == BSX delta (recon-safe regardless of residue).
    const capX = (await stockVal(mX)) - sxBefore;
    const capY = (await stockVal(mY)) - syBefore;
    expect(capX + capY).toBe(135_001n);
    expect(lc.totalCovered).toBe('135001.0000');
    await expectDelta0();
  });

  // ⑦ idempotent replay: same posting key → same document, journal once, no double capitalization.
  it('replays a landed-cost post idempotently (no double capitalization)', async () => {
    const m = await makeMaterial();
    const po = await createPo(m, '20', '1000', 'KRW');
    await receive(po, '20'); // ₩20,000
    const stockBefore = await stockVal(m);

    const first = await landedCosts.post({
      companyCodeId,
      purchaseOrderId: po.id,
      vendorBpId,
      reference: 'CUSTOMS-IDEM',
      postingDate: '2026-03-12',
      documentDate: '2026-03-12',
      currency: 'KRW',
      costAmount: '5000',
      postingKey: `lc:${po.docNo}`,
    });
    const afterFirst = await stockVal(m);
    expect(afterFirst - stockBefore).toBe(5_000n);

    const replay = await landedCosts.post({
      companyCodeId,
      purchaseOrderId: po.id,
      vendorBpId,
      reference: 'CUSTOMS-IDEM',
      postingDate: '2026-03-12',
      documentDate: '2026-03-12',
      currency: 'KRW',
      costAmount: '5000',
      postingKey: `lc:${po.docNo}`,
    });
    expect(replay.landedCostId).toBe(first.landedCostId);
    expect(replay.journalId).toBe(first.journalId);
    expect(replay.replayed).toBe(true);

    // No second capitalization: stock_value unchanged by the replay.
    expect(await stockVal(m)).toBe(afterFirst);
    const rows = await db
      .select()
      .from(schema.landedCost)
      .where(eq(schema.landedCost.postingKey, `lc:${po.docNo}`));
    expect(rows).toHaveLength(1);
    await expectDelta0();
  });
});
