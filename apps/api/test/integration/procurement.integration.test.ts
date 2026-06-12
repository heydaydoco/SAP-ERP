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
import { TaxCodeService } from '../../src/domains/master-data/tax-code/tax-code.service.js';
import { MaterialService } from '../../src/domains/master-data/material/material.service.js';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import { JournalService } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import { ApInvoiceService } from '../../src/domains/finance-accounting/accounts-payable/ap-invoice.service.js';
import { ClearingService } from '../../src/domains/finance-accounting/clearing/clearing.service.js';
import { MaterialValuationService } from '../../src/domains/inventory-warehouse/inventory/material-valuation.service.js';
import { InventoryReconciliationService } from '../../src/domains/inventory-warehouse/inventory/reconciliation.service.js';
import { GoodsMovementService } from '../../src/domains/inventory-warehouse/goods-movement/goods-movement.service.js';
import { ProcurementQueryService } from '../../src/domains/procurement/procurement-query.service.js';
import { PurchaseOrderService } from '../../src/domains/procurement/purchase-order/purchase-order.service.js';
import { GoodsReceiptService } from '../../src/domains/procurement/goods-receipt/goods-receipt.service.js';
import { InvoiceVerificationService } from '../../src/domains/procurement/invoice-verification/invoice-verification.service.js';

/**
 * Procurement P2P integration over a real PostgreSQL 16 (Testcontainers, root CLAUDE.md §5.4). Proves
 * the slice end-to-end: PO (no FI) → GR (reuses goods-movement 101 → Dr BSX / Cr WRX, atomic stock +
 * valuation + journal) → IV (3-way match → Dr WRX / Dr input VAT / Cr AP recon), the GR/IR (입고미착)
 * pair self-clearing to zero on a matched invoice, the derived GRNI open balance on a partial match,
 * the 3-way guards (over-delivery / over-invoice / price tolerance), idempotent replay, the AP open
 * item the IV raises being payable by the clearing slice, and the inventory↔GL reconciliation
 * invariant (delta 0) holding throughout.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('procurement P2P (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let journals: JournalService;
  let movements: GoodsMovementService;
  let purchaseOrders: PurchaseOrderService;
  let goodsReceipts: GoodsReceiptService;
  let invoiceVerifications: InvoiceVerificationService;
  let query: ProcurementQueryService;
  let apInvoices: ApInvoiceService;
  let clearing: ClearingService;
  let recon: InventoryReconciliationService;
  let registry: DbCurrencyRegistry;

  let companyCodeId: string;
  let plantId: string;
  let slocId: string;
  let vendorBpId: string;
  let rawMaterialId: string;

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

  const openApBalance = async (): Promise<string | null> => {
    const items = await apInvoices.listOpenItems({ companyCodeId, partnerId: vendorBpId });
    return items.balance?.amount ?? null;
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
    const taxCodes = new TaxCodeService(db);
    const materials = new MaterialService(db);
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
    query = new ProcurementQueryService(db);
    purchaseOrders = new PurchaseOrderService(db, partners, numbering);
    goodsReceipts = new GoodsReceiptService(db, movements, query);
    invoiceVerifications = new InvoiceVerificationService(
      db,
      journals,
      partners,
      numbering,
      docFlow,
      accountDet,
      query,
      registry,
    );
    apInvoices = new ApInvoiceService(db, journals, partners, registry);
    clearing = new ClearingService(db, journals, accountDet, currencies, registry, glAccounts);

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
      { object: 'finance.ap_invoice', scope: '2026', prefix: 'KR-2026-' },
      { object: 'finance.ap_clearing', scope: '2026', prefix: 'KZ-2026-' },
      { object: 'inventory.goods_movement', scope: '2026', prefix: 'GM-2026-' },
      { object: 'procurement.purchase_order', prefix: 'PO-' },
      { object: 'procurement.invoice_verification', prefix: 'IV-' },
    ]) {
      await numbering.defineRange({ padding: 6, ...range });
    }

    for (const acc of [
      { accountNumber: '1010', name: '현금클리어링', accountType: 'ASSET' as const },
      { accountNumber: '1300', name: '원재료', accountType: 'ASSET' as const },
      { accountNumber: '1350', name: '부가세대급금', accountType: 'ASSET' as const },
      { accountNumber: '5100', name: '원재료비', accountType: 'EXPENSE' as const },
      {
        accountNumber: '2100',
        name: '외상매입금',
        accountType: 'LIABILITY' as const,
        isReconciliation: true,
      },
      { accountNumber: '2110', name: '입고미착', accountType: 'LIABILITY' as const },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }
    for (const rule of [
      { transactionKey: 'BSX', valuationClass: '3000', glAccount: '1300' },
      { transactionKey: 'GBB', valuationClass: '3000', glAccount: '5100' },
      { transactionKey: 'WRX', glAccount: '2110' },
      { transactionKey: 'BANK_CLEARING', glAccount: '1010' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }
    await taxCodes.ensureTaxCode({
      code: 'A10',
      name: '매입 부가세 10%',
      kind: 'INPUT',
      ratePercent: '10',
      glAccount: '1350',
    });

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocId = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId });

    vendorBpId = await partners.ensureBp({
      code: 'V2000',
      name: 'Shenzhen Components Ltd.',
      bpType: 'ORGANIZATION',
      country: 'KR',
      city: 'Seoul',
    });
    await partners.ensureVendorRole(vendorBpId, {
      apReconAccount: '2100',
      paymentTermsDays: 30,
      purchasingBlock: false,
    });

    rawMaterialId = await materials.ensureMaterial({
      code: 'RM-2000',
      name: 'ABS Resin Pellet',
      materialType: 'RAW',
      baseUom: 'KG',
    });
    await valuations.ensureValuation({ materialId: rawMaterialId, plantId, valuationClass: '3000' });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  /** Create a single-line PO: `qty` @ `price` KRW with INPUT VAT A10. */
  const createPo = async (qty: string, price: string) => {
    const po = await purchaseOrders.create({
      companyCodeId,
      vendorBpId,
      currency: 'KRW',
      orderDate: '2026-03-01',
      items: [
        {
          materialId: rawMaterialId,
          plantId,
          storageLocationId: slocId,
          orderedQty: qty,
          unitPrice: price,
          taxCode: 'A10',
        },
      ],
    });
    const full = await purchaseOrders.getPurchaseOrder(po.purchaseOrderId);
    return { id: po.purchaseOrderId, itemId: full.items[0]!.id, docNo: po.docNo };
  };

  // 1 — PO posts NO journal (commitment only).
  it('creates a purchase order without any FI posting', async () => {
    const po = await createPo('100', '1000');
    expect(po.docNo).toMatch(/^PO-000\d{3}$/);
    const got = await purchaseOrders.getPurchaseOrder(po.id);
    expect(got.status).toBe('ORDERED');
    expect(got.items).toHaveLength(1);
    await expectDelta0();
  });

  // 2 — GR reuses goods-movement 101 → Dr BSX / Cr WRX, stock + valuation updated atomically.
  it('posts a goods receipt: Dr stock (BSX) / Cr GR/IR (WRX), with PO lineage', async () => {
    const po = await createPo('100', '1000');
    const gr = await goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, qty: '100' }],
    });
    expect(gr.journalId).toBeTruthy();

    const entry = await journals.getJournal(gr.journalId!);
    expect(entry.docType).toBe('WE');
    const stockLine = entry.lines.find((l) => l.glAccount === '1300')!;
    const wrxLine = entry.lines.find((l) => l.glAccount === '2110')!;
    expect(stockLine).toMatchObject({ drCr: 'D', amount: '100000.0000' });
    expect(wrxLine).toMatchObject({ drCr: 'C', amount: '100000.0000' });

    const [val] = await db
      .select()
      .from(schema.materialValuation)
      .where(
        and(
          eq(schema.materialValuation.materialId, rawMaterialId),
          eq(schema.materialValuation.plantId, plantId),
        ),
      );
    // (this PO contributes 100 @ 1000 to the shared valuation row; assert it at least holds value)
    expect(Number(val!.valuationQty)).toBeGreaterThanOrEqual(100);

    // GR RECEIVES lineage exists (header → PO, line → PO item).
    const recv = await query.receivedByPoItem([po.itemId]);
    expect(recv.get(po.itemId)?.qty6).toBe(100_000000n);
    await expectDelta0();
  });

  // 3 — IV (full, price-matched) → Dr WRX / Dr VAT / Cr AP, GR/IR self-clears to zero.
  it('verifies a matched invoice: relieves GR/IR to zero and raises the AP open item', async () => {
    const po = await createPo('50', '2000');
    await goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, qty: '50' }],
    });

    const beforeAp = await openApBalance();
    const iv = await invoiceVerifications.post({
      companyCodeId,
      purchaseOrderId: po.id,
      reference: 'VINV-1001',
      postingDate: '2026-03-10',
      documentDate: '2026-03-10',
      currency: 'KRW',
      postingKey: `iv:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, invoicedQty: '50', invoiceUnitPrice: '2000' }],
    });
    expect(iv.totalNet).toBe('100000.0000');
    expect(iv.totalTax).toBe('10000.0000');
    expect(iv.grandTotal).toBe('110000.0000');

    const entry = await journals.getJournal(iv.journalId);
    expect(entry.docType).toBe('KR');
    expect(entry.lines.find((l) => l.glAccount === '2110')).toMatchObject({
      drCr: 'D',
      amount: '100000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '1350')).toMatchObject({
      drCr: 'D',
      amount: '10000.0000',
    });
    const ap = entry.lines.find((l) => l.glAccount === '2100')!;
    expect(ap).toMatchObject({ drCr: 'C', amount: '110000.0000', partnerId: vendorBpId });

    // GR/IR for THIS PO nets to zero (received value − invoiced value).
    const grIr = await query.grIrByPurchaseOrder(po.id);
    expect(grIr.lines[0]).toMatchObject({ openQty: '0.000000', grIrOpenAmount: '0.0000' });

    // AP open item grew by the gross (110000 KRW).
    const beforeMinor = beforeAp ? Money.fromNumeric(beforeAp, 'KRW', registry).minorUnits : 0n;
    const afterMinor = Money.fromNumeric((await openApBalance())!, 'KRW', registry).minorUnits;
    expect(afterMinor - beforeMinor).toBe(110000n);
    await expectDelta0();
  });

  // 4 — partial GR + partial IV leave a DERIVED GRNI (입고미착) open balance.
  it('leaves a derived GR/IR open balance on a partial receipt + partial invoice', async () => {
    const po = await createPo('100', '1000');
    await goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, qty: '60' }],
    });
    await invoiceVerifications.post({
      companyCodeId,
      purchaseOrderId: po.id,
      reference: 'VINV-1002',
      postingDate: '2026-03-10',
      documentDate: '2026-03-10',
      currency: 'KRW',
      postingKey: `iv:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, invoicedQty: '40', invoiceUnitPrice: '1000' }],
    });
    const grIr = await query.grIrByPurchaseOrder(po.id);
    expect(grIr.lines[0]).toMatchObject({
      receivedQty: '60.000000',
      invoicedQty: '40.000000',
      openQty: '20.000000',
      grIrOpenAmount: '20000.0000', // 60×1000 − 40×1000
    });
    await expectDelta0();
  });

  // 5 — 3-way guards: over-delivery, over-invoice, and price-beyond-tolerance are blocked.
  it('blocks over-delivery, over-invoice, and out-of-tolerance price', async () => {
    const po = await createPo('100', '1000');
    // Over-delivery: 60 then 50 > 100 ordered.
    await goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}:a`,
      items: [{ purchaseOrderItemId: po.itemId, qty: '60' }],
    });
    await expect(
      goodsReceipts.post({
        purchaseOrderId: po.id,
        postingDate: '2026-03-07',
        postingKey: `gr:${po.docNo}:b`,
        items: [{ purchaseOrderItemId: po.itemId, qty: '50' }],
      }),
    ).rejects.toThrow(/over-delivery/);

    // Over-invoice: only 60 received, invoicing 70 must fail.
    await expect(
      invoiceVerifications.post({
        companyCodeId,
        purchaseOrderId: po.id,
        reference: 'VINV-OVER',
        postingDate: '2026-03-10',
        documentDate: '2026-03-10',
        currency: 'KRW',
        postingKey: `iv:${po.docNo}:over`,
        items: [{ purchaseOrderItemId: po.itemId, invoicedQty: '70', invoiceUnitPrice: '1000' }],
      }),
    ).rejects.toThrow(/3-way match failed/);

    // Price beyond ±1%: 1100 vs PO 1000.
    await expect(
      invoiceVerifications.post({
        companyCodeId,
        purchaseOrderId: po.id,
        reference: 'VINV-PRICE',
        postingDate: '2026-03-10',
        documentDate: '2026-03-10',
        currency: 'KRW',
        postingKey: `iv:${po.docNo}:price`,
        items: [{ purchaseOrderItemId: po.itemId, invoicedQty: '60', invoiceUnitPrice: '1100' }],
      }),
    ).rejects.toThrow(/3-way match failed/);
    await expectDelta0();
  });

  // 5b — duplicate lines on the SAME PO item inside ONE document accumulate against the gates.
  it('blocks over-receipt/over-invoice split across duplicate lines within one document', async () => {
    const po = await createPo('100', '1000');
    // Two GR lines of 60 each (120 > 100 ordered) — each alone passes; together they must not.
    await expect(
      goodsReceipts.post({
        purchaseOrderId: po.id,
        postingDate: '2026-03-06',
        postingKey: `gr:${po.docNo}:dup`,
        items: [
          { purchaseOrderItemId: po.itemId, qty: '60' },
          { purchaseOrderItemId: po.itemId, qty: '60' },
        ],
      }),
    ).rejects.toThrow(/over-delivery/);

    // Receive 50, then one IV with two lines of 30 each (60 > 50 received) — must fail too.
    await goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, qty: '50' }],
    });
    await expect(
      invoiceVerifications.post({
        companyCodeId,
        purchaseOrderId: po.id,
        reference: 'VINV-DUP',
        postingDate: '2026-03-10',
        documentDate: '2026-03-10',
        currency: 'KRW',
        postingKey: `iv:${po.docNo}:dup`,
        items: [
          { purchaseOrderItemId: po.itemId, invoicedQty: '30', invoiceUnitPrice: '1000' },
          { purchaseOrderItemId: po.itemId, invoicedQty: '30', invoiceUnitPrice: '1000' },
        ],
      }),
    ).rejects.toThrow(/3-way match failed/);
    await expectDelta0();
  });

  // 6 — idempotent replay of GR and IV (same posting key → same document, no double post).
  it('replays goods receipt and invoice verification idempotently', async () => {
    const po = await createPo('10', '1000');
    const gr1 = await goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, qty: '10' }],
    });
    const gr2 = await goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, qty: '10' }],
    });
    expect(gr2.goodsMovementId).toBe(gr1.goodsMovementId);

    const iv1 = await invoiceVerifications.post({
      companyCodeId,
      purchaseOrderId: po.id,
      reference: 'VINV-IDEM',
      postingDate: '2026-03-10',
      documentDate: '2026-03-10',
      currency: 'KRW',
      postingKey: `iv:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, invoicedQty: '10', invoiceUnitPrice: '1000' }],
    });
    const iv2 = await invoiceVerifications.post({
      companyCodeId,
      purchaseOrderId: po.id,
      reference: 'VINV-IDEM',
      postingDate: '2026-03-10',
      documentDate: '2026-03-10',
      currency: 'KRW',
      postingKey: `iv:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, invoicedQty: '10', invoiceUnitPrice: '1000' }],
    });
    expect(iv2.invoiceVerificationId).toBe(iv1.invoiceVerificationId);
    expect(iv2.journalId).toBe(iv1.journalId);
    expect(iv2.replayed).toBe(true);

    const ivRows = await db
      .select()
      .from(schema.invoiceVerification)
      .where(eq(schema.invoiceVerification.postingKey, `iv:${po.docNo}`));
    expect(ivRows).toHaveLength(1);
    await expectDelta0();
  });

  // 7 — the AP open item the IV raised is payable by the clearing slice (#13).
  it('lets the clearing slice pay the AP open item the IV created', async () => {
    const po = await createPo('5', '1000');
    await goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, qty: '5' }],
    });
    const iv = await invoiceVerifications.post({
      companyCodeId,
      purchaseOrderId: po.id,
      reference: 'VINV-PAY',
      postingDate: '2026-03-10',
      documentDate: '2026-03-10',
      currency: 'KRW',
      postingKey: `iv:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, invoicedQty: '5', invoiceUnitPrice: '1000' }],
    });

    const cleared = await clearing.clear({
      companyCodeId,
      journalId: iv.journalId,
      partnerId: vendorBpId,
      postingDate: '2026-03-15',
      postingKey: `clr:${po.docNo}`,
    });
    expect(cleared.status).toBe('POSTED');

    // The cleared IV item drops out of the open AP subledger.
    const openItems = await apInvoices.listOpenItems({ companyCodeId, partnerId: vendorBpId });
    expect(openItems.items.find((i) => i.journalId === iv.journalId)).toBeUndefined();
    await expectDelta0();
  });

  // 8 — a fully-matched PO moves WRX by exactly zero (GR credit ↔ IV debit at the PO price).
  it('nets GR/IR (WRX) to zero across a fully-matched PO (delta-checked, order-independent)', async () => {
    const before = await glBalance('2110');
    const po = await createPo('8', '1500');
    await goodsReceipts.post({
      purchaseOrderId: po.id,
      postingDate: '2026-03-06',
      postingKey: `gr:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, qty: '8' }],
    });
    await invoiceVerifications.post({
      companyCodeId,
      purchaseOrderId: po.id,
      reference: 'VINV-NET0',
      postingDate: '2026-03-10',
      documentDate: '2026-03-10',
      currency: 'KRW',
      postingKey: `iv:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, invoicedQty: '8', invoiceUnitPrice: '1500' }],
    });
    expect((await glBalance('2110')) - before).toBe(0n);
    const grIr = await query.grIrByPurchaseOrder(po.id);
    expect(grIr.lines[0]).toMatchObject({ openQty: '0.000000', grIrOpenAmount: '0.0000' });
    await expectDelta0();
  });

  // 9 — Option A honesty: an EXACT price match does NOT net WRX to zero when the GR and IV split the
  // same quantity differently on a fractional unit price — each partial line rounds independently, so
  // a sub-unit GR/IR rounding residue (dust) remains. The journals stay balanced and recon stays 0;
  // the dust is cleared by the future PRD/MR11 slice (Option B). PO 3 @ 10.5 KRW: 3 GRs of 1
  // (round(10.5)=11 each ⇒ 33 credited) vs 1 IV of 3 (round(31.5)=32 debited) ⇒ +1 KRW left on WRX.
  it('leaves a sub-unit GR/IR rounding residue on an exact match with asymmetric splits', async () => {
    const before = await glBalance('2110');
    const po = await createPo('3', '10.5');
    for (const n of [1, 2, 3]) {
      await goodsReceipts.post({
        purchaseOrderId: po.id,
        postingDate: '2026-03-06',
        postingKey: `gr:${po.docNo}:r${n}`,
        items: [{ purchaseOrderItemId: po.itemId, qty: '1' }],
      });
    }
    // GR credited WRX 11 × 3 = 33 (in D−C terms, −33).
    expect((await glBalance('2110')) - before).toBe(-33n);

    const iv = await invoiceVerifications.post({
      companyCodeId,
      purchaseOrderId: po.id,
      reference: 'VINV-DUST',
      postingDate: '2026-03-10',
      documentDate: '2026-03-10',
      currency: 'KRW',
      postingKey: `iv:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, invoicedQty: '3', invoiceUnitPrice: '10.5' }],
    });
    // IV net = round(3 × 10.5) = 32 (not 33); VAT 10% of 32 = round(3.2) = 3; gross 35.
    expect(iv.totalNet).toBe('32.0000');
    expect(iv.totalTax).toBe('3.0000');
    expect(iv.grandTotal).toBe('35.0000');

    // The dust: WRX is left with a 1 KRW credit balance (33 credited − 32 debited) — EXACT price
    // match, yet NOT zero. The derived GR/IR view shows it as a 1 KRW open value on a fully
    // invoiced (openQty 0) line.
    expect((await glBalance('2110')) - before).toBe(-1n);
    const grIr = await query.grIrByPurchaseOrder(po.id);
    expect(grIr.lines[0]).toMatchObject({ openQty: '0.000000', grIrOpenAmount: '1.0000' });

    // Integrity holds regardless of the dust: the IV journal balanced (it posted) and Σstock_value
    // still ties to BSX to the cent.
    await expectDelta0();
  });
});
