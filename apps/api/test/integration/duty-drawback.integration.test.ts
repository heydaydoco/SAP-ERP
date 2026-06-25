import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
import { DutyDrawbackService } from '../../src/domains/trade-compliance/duty-drawback/duty-drawback.service.js';
import {
  DOC_FLOW_TYPE_DRAWBACK_CLAIM,
  DOC_FLOW_TYPE_DRAWBACK_SOURCE_EXPORT,
  DOC_FLOW_TYPE_JOURNAL,
  REL_POSTS,
  REL_REFUNDS,
} from '../../src/domains/trade-compliance/trade-compliance.constants.js';

/**
 * Duty-drawback (관세환급, 간이정액) integration over a real PostgreSQL 16 (Testcontainers, §5.4) — the FIRST
 * POSTING document of trade-compliance. Builds a real source (SO → 601 delivery → 수출신고 → 수리), then a
 * refund claim over it, and proves: create is NON-POSTING (전표 0) and writes one REFUNDS edge per distinct
 * source 수출신고; the 간이정액 refund math (FOB→KRW × 환급률/10,000, incl. the 수리일 FX path); approve posts
 * the FIRST real FI journal (Dr 1140 관세환급금미수금 / Cr 9830 관세환급수익, balanced) + a POSTS edge; approve
 * is idempotent (replay posts nothing); and G1 (률 누락) is a soft warning with 환급액 0.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('trade-compliance 관세환급 (duty drawback, 간이정액) (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let movements: GoodsMovementService;
  let salesOrders: SalesOrderService;
  let deliveries: DeliveryService;
  let exportDeclarations: ExportDeclarationService;
  let drawbacks: DutyDrawbackService;
  let companyCodeId: string;
  let plantId: string;
  let slocA: string;
  let customerBpId: string;

  const journalCount = async (): Promise<number> => {
    const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(schema.journalEntry);
    return row?.c ?? 0;
  };

  /** Net (Dr−Cr) minor units on a GL account within one journal entry — proves the Dr/Cr leg + amount. */
  const lineAmount = async (entryId: string, account: string) => {
    const rows = await db
      .select({ drCr: schema.journalLine.drCr, amount: schema.journalLine.amount })
      .from(schema.journalLine)
      .where(
        and(eq(schema.journalLine.journalEntryId, entryId), eq(schema.journalLine.glAccount, account)),
      );
    return rows;
  };

  const load561 = (materialId: string, qty: string, price: string) =>
    movements.post({
      plantId,
      movementType: '561',
      postingDate: '2026-03-01',
      items: [{ materialId, storageLocationId: slocA, qty, unitPrice: price }],
    });

  let matSeq = 0;
  const newTradeMaterial = async (hsCode: string, qty = '100', price = '100') => {
    matSeq += 1;
    const materials = new MaterialService(db);
    const id = await materials.ensureMaterial({
      code: `DD-${matSeq}`,
      name: `Drawback material ${matSeq}`,
      materialType: 'FINISHED',
      baseUom: 'EA',
    });
    await new MaterialValuationService(db).ensureValuation({ materialId: id, plantId, valuationClass: '3000' });
    await materials.ensureTradeData(id, { hsCode, countryOfOrigin: 'KR' });
    if (Number(qty) > 0) await load561(id, qty, price);
    return id;
  };

  /** A FINISHED material with stock but NO material_trade (→ a 수출신고 line snapshots a NULL HS). */
  const newPlainMaterial = async (qty = '100', price = '100') => {
    matSeq += 1;
    const materials = new MaterialService(db);
    const id = await materials.ensureMaterial({
      code: `DDX-${matSeq}`,
      name: `No-trade material ${matSeq}`,
      materialType: 'FINISHED',
      baseUom: 'EA',
    });
    await new MaterialValuationService(db).ensureValuation({ materialId: id, plantId, valuationClass: '3000' });
    if (Number(qty) > 0) await load561(id, qty, price);
    return id;
  };

  /** SO → 601 delivery for `materialId`; returns the deliveryId. */
  const sellAndDeliver = async (materialId: string, qty: string, currency: string) => {
    const so = await salesOrders.create({
      companyCodeId,
      customerBpId,
      currency,
      orderDate: '2026-03-02',
      items: [{ materialId, plantId, storageLocationId: slocA, orderedQty: qty, unitPrice: '100' }],
    });
    const soItemId = (await salesOrders.getSalesOrder(so.salesOrderId)).items[0]!.id;
    const delivery = await deliveries.post({
      salesOrderId: so.salesOrderId,
      postingDate: '2026-03-03',
      items: [{ salesOrderItemId: soItemId, qty }],
    });
    return delivery.deliveryId;
  };

  /** Build an ACCEPTED 수출신고 with one line; returns its id + the line's id. */
  const acceptedExport = async (
    materialId: string,
    fobAmount: string,
    currency: string,
    acceptanceDate: string,
  ): Promise<{ declarationId: string; itemId: string }> => {
    const deliveryId = await sellAndDeliver(materialId, '10', currency);
    const created = await exportDeclarations.create({
      companyCodeId,
      customerBpId,
      sourceDeliveryId: deliveryId,
      declarationDate: '2026-03-05',
      currency,
      items: [{ materialId, qty: '10', uom: 'EA', fobAmount }],
    });
    await exportDeclarations.accept(created.exportDeclarationId, {
      declarationNo: `MRN-${matSeq}`,
      acceptanceDate,
    });
    const full = await exportDeclarations.getExportDeclaration(created.exportDeclarationId);
    return { declarationId: created.exportDeclarationId, itemId: full.items[0]!.id };
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
    exportDeclarations = new ExportDeclarationService(db, partners, numbering, docFlow, currencies, registry);
    drawbacks = new DutyDrawbackService(db, numbering, docFlow, currencies, registry, accountDet, journals);

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
      { object: 'inventory.goods_movement', scope: '2026', prefix: 'GM-2026-' },
      { object: 'sales.sales_order', prefix: 'SO-' },
      { object: 'trade.export_declaration', prefix: 'ED-' },
      { object: 'trade.drawback_claim', prefix: 'DD-' },
    ]) {
      await numbering.defineRange({ padding: 6, ...range });
    }

    for (const acc of [
      { accountNumber: '1100', name: '외상매출금', accountType: 'ASSET' as const, isReconciliation: true },
      { accountNumber: '1300', name: '원재료', accountType: 'ASSET' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
      { accountNumber: '5200', name: '매출원가', accountType: 'EXPENSE' as const },
      { accountNumber: '9800', name: '외환차손익', accountType: 'EXPENSE' as const },
      // Duty-drawback accounts under test.
      { accountNumber: '1140', name: '관세환급금미수금', accountType: 'ASSET' as const },
      { accountNumber: '9830', name: '관세환급수익', accountType: 'REVENUE' as const },
      // 보통예금/현금클리어링 (currency null by omission) — where the 환급금 입금(receipt) lands (BANK_CLEARING).
      { accountNumber: '1010', name: '보통예금', accountType: 'ASSET' as const },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }
    for (const rule of [
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' },
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' },
      { transactionKey: 'COGS', glAccount: '5200' },
      { transactionKey: 'FX_ROUNDING', glAccount: '9800' },
      { transactionKey: 'DUTY_DRAWBACK_RECEIVABLE', glAccount: '1140' },
      { transactionKey: 'DUTY_DRAWBACK_INCOME', glAccount: '9830' },
      // receipt() cash leg — the same BANK_CLEARING key the finance clearing slice uses (→ 1010).
      { transactionKey: 'BANK_CLEARING', glAccount: '1010' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    // 간이정액환급률: HS 8471606000 = 50원/만원 (effective 2026-01-01, open-ended).
    await db.insert(schema.drawbackSimplifiedRate).values({
      hsCode: '8471606000',
      ratePer10k: '50.0000',
      validFrom: '2026-01-01',
      createdBy: 'system',
      updatedBy: 'system',
    });

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocA = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId });
    customerBpId = await partners.ensureBp({ code: 'C-BUYER', name: 'Foreign Buyer LLC', bpType: 'ORGANIZATION', country: 'US' });
    await partners.ensureCustomerRole(customerBpId, { arReconAccount: '1100', paymentTermsDays: 30, salesBlock: false });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — KRW lifecycle: create (CLAIMED, NO journal, 1 REFUNDS edge, claimed_total) → approve (1 balanced
  //     journal Dr 1140 / Cr 9830 + POSTS edge, APPROVED) → approve replay is idempotent (still 1 journal).
  it('creates a CLAIMED claim with no journal + a REFUNDS edge, then approve posts Dr 1140 / Cr 9830 once', async () => {
    const mat = await newTradeMaterial('8471606000');
    const src = await acceptedExport(mat, '1000000', 'KRW', '2026-03-10');

    const journalsBefore = await journalCount();
    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: src.declarationId, sourceExportDeclarationItemRef: src.itemId }],
    });

    expect(created.docNo).toMatch(/^DD-\d{6}$/);
    expect(created.status).toBe('CLAIMED');
    // 1,000,000원 (KRW FOB) / 10,000 × 50원 = 5,000원.
    expect(created.claimedTotalAmount).toBe('5000.0000');
    expect(created.warnings).toEqual([]); // ACCEPTED, rate matched, deadline far, no manual override.

    // create posts NOTHING to FI.
    expect(await journalCount()).toBe(journalsBefore);

    // One REFUNDS edge: claim → the source 수출신고.
    const refundEdges = await db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_DRAWBACK_CLAIM),
          eq(schema.docFlow.sourceId, created.drawbackClaimId),
          eq(schema.docFlow.relType, REL_REFUNDS),
        ),
      );
    expect(refundEdges).toHaveLength(1);
    expect(refundEdges[0]).toMatchObject({
      targetType: DOC_FLOW_TYPE_DRAWBACK_SOURCE_EXPORT,
      targetId: src.declarationId,
    });

    const line = (await drawbacks.getDrawbackClaim(created.drawbackClaimId)).items[0]!;
    expect(line).toMatchObject({
      hsCode: '8471606000',
      fobCurrency: 'KRW',
      fobKrwAmount: '1000000.0000',
      fxRate: null, // domestic — no conversion
      appliedRate: '50.0000',
      lineRefundAmount: '5000.0000',
      sourceAcceptanceDate: '2026-03-10',
    });

    // approve → the FIRST real FI journal in trade-compliance.
    const approved = await drawbacks.approve(created.drawbackClaimId, { approvalDate: '2026-04-10' });
    expect(approved).toMatchObject({ status: 'APPROVED', approvedTotalAmount: '5000.0000', replayed: false });
    expect(await journalCount()).toBe(journalsBefore + 1);

    // Dr 1140 관세환급금미수금 = Cr 9830 관세환급수익 = 5,000원 (balanced, two lines).
    const dr = await lineAmount(approved.journalId, '1140');
    const cr = await lineAmount(approved.journalId, '9830');
    expect(dr).toEqual([{ drCr: 'D', amount: '5000.0000' }]);
    expect(cr).toEqual([{ drCr: 'C', amount: '5000.0000' }]);

    // POSTS edge: claim → journal (subledger-owned, FI reverse-fenced).
    const postsEdges = await db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_DRAWBACK_CLAIM),
          eq(schema.docFlow.sourceId, created.drawbackClaimId),
          eq(schema.docFlow.relType, REL_POSTS),
        ),
      );
    expect(postsEdges).toHaveLength(1);
    expect(postsEdges[0]).toMatchObject({ targetType: DOC_FLOW_TYPE_JOURNAL, targetId: approved.journalId });

    // approve replay is idempotent — no second journal.
    const replay = await drawbacks.approve(created.drawbackClaimId, { approvalDate: '2026-04-10' });
    expect(replay).toMatchObject({ status: 'APPROVED', replayed: true, journalId: approved.journalId });
    expect(await journalCount()).toBe(journalsBefore + 1);
  });

  // 2 — foreign FOB: fob_krw is auto-converted at the source 수리일 'M' rate, with the rate snapshotted.
  it('auto-converts a USD FOB to KRW at the 수리일 rate and snapshots fx_rate', async () => {
    const mat = await newTradeMaterial('8471606000');
    const src = await acceptedExport(mat, '1000.00', 'USD', '2026-03-10');

    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: src.declarationId, sourceExportDeclarationItemRef: src.itemId }],
    });
    // 1,000 USD × 1,300 = 1,300,000원 → /10,000 × 50 = 6,500원.
    expect(created.claimedTotalAmount).toBe('6500.0000');
    const line = (await drawbacks.getDrawbackClaim(created.drawbackClaimId)).items[0]!;
    expect(line).toMatchObject({
      fobCurrency: 'USD',
      fobAmount: '1000.0000',
      fobKrwAmount: '1300000.0000',
      fxRate: '1300.000000',
      lineRefundAmount: '6500.0000',
    });
  });

  // 3 — multi-source: a claim bundling two distinct 수출신고 writes one REFUNDS edge PER distinct source.
  it('writes one REFUNDS edge per distinct source 수출신고 and sums the claimed total', async () => {
    const m1 = await newTradeMaterial('8471606000');
    const m2 = await newTradeMaterial('8471606000');
    const s1 = await acceptedExport(m1, '1000000', 'KRW', '2026-03-10');
    const s2 = await acceptedExport(m2, '2000000', 'KRW', '2026-03-10');

    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [
        { sourceExportDeclarationId: s1.declarationId, sourceExportDeclarationItemRef: s1.itemId },
        { sourceExportDeclarationId: s2.declarationId, sourceExportDeclarationItemRef: s2.itemId },
      ],
    });
    // 5,000 + 10,000 = 15,000원.
    expect(created.claimedTotalAmount).toBe('15000.0000');
    const edges = await db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_DRAWBACK_CLAIM),
          eq(schema.docFlow.sourceId, created.drawbackClaimId),
          eq(schema.docFlow.relType, REL_REFUNDS),
        ),
      );
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.targetId))).toEqual(new Set([s1.declarationId, s2.declarationId]));
  });

  // 4 — G1 soft gate: an HS with no 간이정액률 → applied_rate 0, refund 0, SIMPLIFIED_RATE_NOT_FOUND (no block).
  it('soft-warns (률 누락) and computes 환급액 0 for an HS with no 간이정액률', async () => {
    const mat = await newTradeMaterial('9999999999'); // no rate seeded for this HS
    const src = await acceptedExport(mat, '1000000', 'KRW', '2026-03-10');

    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: src.declarationId, sourceExportDeclarationItemRef: src.itemId }],
    });
    expect(created.claimedTotalAmount).toBe('0.0000');
    expect(created.warnings).toContainEqual(
      expect.objectContaining({ severity: 'WARN', code: 'SIMPLIFIED_RATE_NOT_FOUND', lineNo: 1 }),
    );
    const line = (await drawbacks.getDrawbackClaim(created.drawbackClaimId)).items[0]!;
    expect(line.appliedRate).toBe('0.0000');
  });

  // 5 — guards: an 0-total claim cannot be approved (nothing to post); an unknown claim 404s; a 결정액
  //     override is accepted on approve.
  it('rejects approving a 0-total claim, 404s an unknown claim, and honors a 결정액 override', async () => {
    // 0-total (no-rate HS) → approve refused.
    const matZero = await newTradeMaterial('9999999999');
    const zeroSrc = await acceptedExport(matZero, '1000000', 'KRW', '2026-03-10');
    const zero = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: zeroSrc.declarationId, sourceExportDeclarationItemRef: zeroSrc.itemId }],
    });
    await expect(drawbacks.approve(zero.drawbackClaimId, { approvalDate: '2026-04-10' })).rejects.toThrow(
      /approved total is 0/,
    );

    await expect(
      drawbacks.approve(randomUUID(), { approvalDate: '2026-04-10' }),
    ).rejects.toThrow(/not found/);

    // 결정액 override (관세청 결정 < 신청액): approve with an explicit approvedTotal posts that amount.
    const mat = await newTradeMaterial('8471606000');
    const src = await acceptedExport(mat, '1000000', 'KRW', '2026-03-10');
    const claim = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: src.declarationId, sourceExportDeclarationItemRef: src.itemId }],
    });
    const approved = await drawbacks.approve(claim.drawbackClaimId, {
      approvalDate: '2026-04-10',
      approvedTotal: '4500',
    });
    expect(approved.approvedTotalAmount).toBe('4500.0000');
    const dr = await lineAmount(approved.journalId, '1140');
    expect(dr).toEqual([{ drCr: 'D', amount: '4500.0000' }]);
  });

  // 6 — manual 원화 FOB override bypasses FX: a foreign line whose 수리일 has NO 'M' rate is valued by the
  //     manual fobKrw (not a 404); without the override the genuine no-value path is a clear error.
  it('values a foreign line by the manual 원화 FOB when no 수리일 rate exists, and 400s without it', async () => {
    const mat = await newTradeMaterial('8471606000');
    // Accepted on 2026-02-25 — BEFORE the USD→KRW rate's valid_from (2026-03-01) → no rate at the 수리일.
    const src = await acceptedExport(mat, '1000.00', 'USD', '2026-02-25');

    // No manual override → cannot value the foreign FOB → hard error (a genuine computational prerequisite).
    await expect(
      drawbacks.create({
        companyCodeId,
        claimDate: '2026-04-01',
        items: [{ sourceExportDeclarationId: src.declarationId, sourceExportDeclarationItemRef: src.itemId }],
      }),
    ).rejects.toThrow(/cannot be valued/);

    // With a manual 원화 FOB the override wins (fx_rate NULL), the rate-table still matches the 수리일.
    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [
        {
          sourceExportDeclarationId: src.declarationId,
          sourceExportDeclarationItemRef: src.itemId,
          fobKrw: '1500000',
        },
      ],
    });
    // 1,500,000원 (manual) / 10,000 × 50 = 7,500원; no G3 (no auto value to compare against).
    expect(created.claimedTotalAmount).toBe('7500.0000');
    const line = (await drawbacks.getDrawbackClaim(created.drawbackClaimId)).items[0]!;
    expect(line).toMatchObject({ fobKrwAmount: '1500000.0000', fxRate: null, appliedRate: '50.0000' });
    expect(created.warnings.find((w) => w.code === 'MANUAL_FOB_KRW_DEVIATION')).toBeUndefined();
  });

  // 7 — a source 수출신고 line with NO HS is SOFT (refund 0 + SOURCE_HS_MISSING), never a hard block.
  it('soft-warns (SOURCE_HS_MISSING) and computes 환급액 0 when the source export line has no HS', async () => {
    const mat = await newPlainMaterial(); // no material_trade → the export line snapshots a NULL HS
    const deliveryId = await sellAndDeliver(mat, '10', 'KRW');
    const exp = await exportDeclarations.create({
      companyCodeId,
      customerBpId,
      sourceDeliveryId: deliveryId,
      declarationDate: '2026-03-05',
      currency: 'KRW',
      items: [{ materialId: mat, qty: '10', uom: 'EA', fobAmount: '1000000' }], // hsCode omitted → NULL
    });
    await exportDeclarations.accept(exp.exportDeclarationId, { declarationNo: 'MRN-noHS', acceptanceDate: '2026-03-10' });
    const itemId = (await exportDeclarations.getExportDeclaration(exp.exportDeclarationId)).items[0]!.id;

    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: exp.exportDeclarationId, sourceExportDeclarationItemRef: itemId }],
    });
    expect(created.claimedTotalAmount).toBe('0.0000');
    expect(created.warnings).toContainEqual(
      expect.objectContaining({ severity: 'WARN', code: 'SOURCE_HS_MISSING', lineNo: 1 }),
    );
    const line = (await drawbacks.getDrawbackClaim(created.drawbackClaimId)).items[0]!;
    expect(line.hsCode).toBe(''); // deterministic NOT-NULL snapshot for the missing case
  });

  // 8 — receipt (입금) lifecycle: approve opens the 1140 receivable; receipt posts the MIRROR journal
  //     Dr 1010 보통예금 / Cr 1140, flips APPROVED → PAID, and the 1140 미수금 nets to 0 across both journals.
  it('approve → receipt posts the mirror Dr 1010 / Cr 1140 once, nets 1140 to 0, and flips to PAID', async () => {
    const mat = await newTradeMaterial('8471606000');
    const src = await acceptedExport(mat, '1000000', 'KRW', '2026-03-10');
    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: src.declarationId, sourceExportDeclarationItemRef: src.itemId }],
    });
    const approved = await drawbacks.approve(created.drawbackClaimId, { approvalDate: '2026-04-10' });
    // approve OPENED the receivable: Dr 1140 = 5,000.
    expect(await lineAmount(approved.journalId, '1140')).toEqual([{ drCr: 'D', amount: '5000.0000' }]);

    const journalsBeforeReceipt = await journalCount();
    const paid = await drawbacks.receipt(created.drawbackClaimId, { receiptDate: '2026-04-20' });
    expect(paid).toMatchObject({
      status: 'PAID',
      replayed: false,
      receivedAmount: '5000.0000',
      receivedCurrency: 'KRW',
    });
    // receipt posts exactly ONE new journal.
    expect(await journalCount()).toBe(journalsBeforeReceipt + 1);

    // Mirror journal: Dr 1010 보통예금 / Cr 1140 관세환급금미수금 = 5,000원 (balanced, two lines).
    expect(await lineAmount(paid.journalId, '1010')).toEqual([{ drCr: 'D', amount: '5000.0000' }]);
    expect(await lineAmount(paid.journalId, '1140')).toEqual([{ drCr: 'C', amount: '5000.0000' }]);

    // 1140 미수금 nets to 0 across the cycle (approve Dr 5,000 + receipt Cr 5,000) — the claim is settled.
    const lines1140 = await db
      .select({ drCr: schema.journalLine.drCr, amount: schema.journalLine.amount })
      .from(schema.journalLine)
      .where(
        and(
          eq(schema.journalLine.glAccount, '1140'),
          inArray(schema.journalLine.journalEntryId, [approved.journalId, paid.journalId]),
        ),
      );
    const net1140 = lines1140.reduce((s, l) => s + (l.drCr === 'D' ? 1 : -1) * Number(l.amount), 0);
    expect(net1140).toBe(0);

    // The claim status row is PAID with the input stamps recorded.
    const header = await drawbacks.getDrawbackClaim(created.drawbackClaimId);
    expect(header).toMatchObject({
      status: 'PAID',
      receiptDate: '2026-04-20',
      receivedAmount: '5000.0000',
      receivedCurrency: 'KRW',
    });

    // POSTS edge: claim → receipt journal. The claim now carries TWO POSTS edges (approve + receipt);
    // the receipt's targets the NEW journal (subledger-owned, FI reverse-fenced).
    const postsEdges = await db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_DRAWBACK_CLAIM),
          eq(schema.docFlow.sourceId, created.drawbackClaimId),
          eq(schema.docFlow.relType, REL_POSTS),
        ),
      );
    expect(postsEdges).toHaveLength(2);
    expect(new Set(postsEdges.map((e) => e.targetId))).toEqual(
      new Set([approved.journalId, paid.journalId]),
    );
  });

  // 9 — receipt is idempotent on the claim: a replay posts NOTHING and returns the same journal (the
  //     deterministic posting key recovers THIS journal, not the approve one, despite two POSTS edges).
  it('replays an already-PAID claim — no second journal, same journalId', async () => {
    const mat = await newTradeMaterial('8471606000');
    const src = await acceptedExport(mat, '1000000', 'KRW', '2026-03-10');
    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: src.declarationId, sourceExportDeclarationItemRef: src.itemId }],
    });
    await drawbacks.approve(created.drawbackClaimId, { approvalDate: '2026-04-10' });
    const paid = await drawbacks.receipt(created.drawbackClaimId, { receiptDate: '2026-04-20' });

    const journalsAfterFirst = await journalCount();
    const replay = await drawbacks.receipt(created.drawbackClaimId, { receiptDate: '2026-04-20' });
    expect(replay).toMatchObject({
      status: 'PAID',
      replayed: true,
      journalId: paid.journalId,
      receivedAmount: '5000.0000',
      receivedCurrency: 'KRW',
    });
    expect(await journalCount()).toBe(journalsAfterFirst);
  });

  // 10 — state guard: only an APPROVED claim can be 입금처리. A still-CLAIMED claim 409s (approve first).
  it('refuses receipt on a non-APPROVED (CLAIMED) claim', async () => {
    const mat = await newTradeMaterial('8471606000');
    const src = await acceptedExport(mat, '1000000', 'KRW', '2026-03-10');
    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: src.declarationId, sourceExportDeclarationItemRef: src.itemId }],
    });
    await expect(
      drawbacks.receipt(created.drawbackClaimId, { receiptDate: '2026-04-20' }),
    ).rejects.toThrow(/only an APPROVED claim/);
  });

  // 11 — full-receipt only (v1): a 입금액 ≠ 승인액 is rejected; the exact approved total (incl. the
  //      canonical '5000.0000') is accepted.
  it('rejects a partial receipt and accepts the exact approved total', async () => {
    const mat = await newTradeMaterial('8471606000');
    const src = await acceptedExport(mat, '1000000', 'KRW', '2026-03-10');
    const created = await drawbacks.create({
      companyCodeId,
      claimDate: '2026-04-01',
      items: [{ sourceExportDeclarationId: src.declarationId, sourceExportDeclarationItemRef: src.itemId }],
    });
    await drawbacks.approve(created.drawbackClaimId, { approvalDate: '2026-04-10' }); // 승인액 5,000

    // Partial (4,000 ≠ 5,000) → 400, BEFORE any state change (claim stays APPROVED).
    await expect(
      drawbacks.receipt(created.drawbackClaimId, { receiptDate: '2026-04-20', receivedAmount: '4000' }),
    ).rejects.toThrow(/부분입금은 스코프 밖/);

    // The exact approved total IS accepted — including the canonical NUMERIC '5000.0000' (fromNumeric path).
    const paid = await drawbacks.receipt(created.drawbackClaimId, {
      receiptDate: '2026-04-20',
      receivedAmount: '5000.0000',
    });
    expect(paid).toMatchObject({ status: 'PAID', receivedAmount: '5000.0000' });
  });
});
