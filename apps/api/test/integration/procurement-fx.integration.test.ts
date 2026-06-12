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
 * Foreign-currency import P2P integration over a real PostgreSQL 16 (Testcontainers, §5.4). Proves
 * the import slice end-to-end: a USD PO → GR that values stock in KRW at the GR-date 'M' rate
 * (Option P — the goods-movement engine stays functional-currency-only, the caller pre-translates)
 * with the foreign trade trace stamped on the movement line → a USD IV that relieves GR/IR (WRX) at
 * the GR-date functional value and posts the GR↔IV rate difference to realized FX gain/loss (the
 * clearing #13 pattern), the WRX account extinguishing to EXACTLY zero in the functional currency,
 * the USD AP open item being payable by clearing, and the inventory↔GL reconciliation invariant
 * (delta 0) holding throughout. GR rate 1300; IV rate 1400 (loss) / 1200 (gain) / 1300 (zero).
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('procurement import FX (integration)', () => {
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
    goodsReceipts = new GoodsReceiptService(db, movements, query, currencies, registry);
    invoiceVerifications = new InvoiceVerificationService(
      db,
      journals,
      partners,
      numbering,
      docFlow,
      accountDet,
      query,
      registry,
      currencies,
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
    await currencies.ensureCurrency({ code: 'USD', name: 'US Dollar', minorUnit: 2 });
    // USD→KRW 'M' rates: GR date (1300), IV loss date (1400), IV gain date (1200). resolveRate picks
    // the latest valid_from ≤ the document date.
    for (const fx of [
      { validFrom: '2026-03-01', rate: '1300.000000' },
      { validFrom: '2026-03-10', rate: '1400.000000' },
      { validFrom: '2026-03-15', rate: '1200.000000' },
    ]) {
      await currencies.ensureFxRate({ fromCurrency: 'USD', toCurrency: 'KRW', rateType: 'M', ...fx });
    }

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
      // FX accounts — all currency = null (omitted) so a 0-amount foreign line is not rejected.
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
      { transactionKey: 'BANK_CLEARING', glAccount: '1010' },
      { transactionKey: 'FX_ROUNDING', glAccount: '9800' },
      { transactionKey: 'REALIZED_FX_GAIN', glAccount: '9810' },
      { transactionKey: 'REALIZED_FX_LOSS', glAccount: '9820' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    plantId = await org.ensurePlant({ code: '1010', name: 'Seoul Main Plant', companyCodeId });
    slocId = await org.ensureStorageLocation({ code: '0001', name: 'Main', plantId });

    vendorBpId = await partners.ensureBp({
      code: 'V3000',
      name: 'Shenzhen Imports Ltd.',
      bpType: 'ORGANIZATION',
      country: 'CN',
      city: 'Shenzhen',
    });
    await partners.ensureVendorRole(vendorBpId, {
      apReconAccount: '2100',
      paymentTermsDays: 30,
      purchasingBlock: false,
    });

    rawMaterialId = await materials.ensureMaterial({
      code: 'RM-IMP',
      name: 'Imported Resin',
      materialType: 'RAW',
      baseUom: 'KG',
    });
    await valuations.ensureValuation({ materialId: rawMaterialId, plantId, valuationClass: '3000' });

    // INPUT VAT code for the secondary VAT-present mechanism check (foreign supplier invoices are
    // normally zero-rated — import VAT is customs-paid, a later landed-cost slice).
    const taxCodes = new TaxCodeService(db);
    await taxCodes.ensureTaxCode({
      code: 'A10',
      name: '매입 부가세 10%',
      kind: 'INPUT',
      ratePercent: '10',
      glAccount: '1350',
    });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  /** Create a single-line USD import PO (no Korean VAT — import VAT is customs-paid, a later slice). */
  const createImportPo = async (qty: string, price: string) => {
    const po = await purchaseOrders.create({
      companyCodeId,
      vendorBpId,
      currency: 'USD',
      orderDate: '2026-03-01',
      items: [{ materialId: rawMaterialId, plantId, storageLocationId: slocId, orderedQty: qty, unitPrice: price }],
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

  const invoice = (
    po: { id: string; itemId: string; docNo: string },
    qty: string,
    price: string,
    documentDate: string,
  ) =>
    invoiceVerifications.post({
      companyCodeId,
      purchaseOrderId: po.id,
      reference: `VINV-${po.docNo}`,
      postingDate: documentDate,
      documentDate,
      currency: 'USD',
      postingKey: `iv:${po.docNo}`,
      items: [{ purchaseOrderItemId: po.itemId, invoicedQty: qty, invoiceUnitPrice: price }],
    });

  // 1 — import GR values stock in KRW at the GR-date rate (Dr BSX / Cr WRX KRW) + trade trace.
  it('values an import GR in KRW at the GR-date rate and stamps the foreign trade trace', async () => {
    const po = await createImportPo('10', '100'); // $100/unit
    const gr = await receive(po, '10');
    const entry = await journals.getJournal(gr.journalId!);
    expect(entry.docType).toBe('WE');
    expect(entry.currency).toBe('KRW'); // Option P: the GR journal is a plain KRW document
    // $1,000 × 1300 = ₩1,300,000 on both stock (BSX 1300) and GR/IR (WRX 2110).
    expect(entry.lines.find((l) => l.glAccount === '1300')).toMatchObject({ drCr: 'D', amount: '1300000.0000' });
    expect(entry.lines.find((l) => l.glAccount === '2110')).toMatchObject({ drCr: 'C', amount: '1300000.0000' });

    const [item] = await db
      .select()
      .from(schema.goodsMovementItem)
      .where(eq(schema.goodsMovementItem.goodsMovementId, gr.goodsMovementId));
    expect(item).toMatchObject({
      amount: '1300000.0000',
      currency: 'KRW',
      documentCurrency: 'USD',
      exchangeRate: '1300.000000',
      documentAmount: '1000.0000',
    });

    const recv = await query.receivedByPoItem([po.itemId]);
    expect(recv.get(po.itemId)).toMatchObject({ amount: '1300000.0000', documentAmount: '1000.0000' });
    await expectDelta0();
  });

  // 2 — import IV at a HIGHER rate (USD strengthened) → realized FX LOSS; WRX nets to zero.
  it('books a realized FX loss when the invoice rate exceeds the GR rate (and extinguishes WRX)', async () => {
    const wrxBefore = await glBalance('2110');
    const po = await createImportPo('10', '100');
    await receive(po, '10'); // GR rate 1300 → WRX credited ₩1,300,000
    const iv = await invoice(po, '10', '100', '2026-03-12'); // IV rate 1400

    expect(iv.totalNet).toBe('1000.0000');
    expect(iv.totalTax).toBe('0.0000');
    expect(iv.grandTotal).toBe('1000.0000');

    const entry = await journals.getJournal(iv.journalId);
    expect(entry.docType).toBe('KR');
    expect(entry.currency).toBe('USD');
    expect(entry.fxRate).toBe('1400.000000');
    // WRX relieved at the GR-date functional value (₩1,300,000), document amount the invoiced $1,000.
    expect(entry.lines.find((l) => l.glAccount === '2110')).toMatchObject({
      drCr: 'D',
      amount: '1000.0000',
      functionalAmount: '1300000.0000',
    });
    // AP at the invoice-date rate: $1,000 × 1400 = ₩1,400,000.
    expect(entry.lines.find((l) => l.glAccount === '2100')).toMatchObject({
      drCr: 'C',
      amount: '1000.0000',
      functionalAmount: '1400000.0000',
      partnerId: vendorBpId,
    });
    // Realized FX loss: ₩100,000 = $1,000 × (1400 − 1300), 0 in the document currency.
    expect(entry.lines.find((l) => l.glAccount === '9820')).toMatchObject({
      drCr: 'D',
      amount: '0.0000',
      functionalAmount: '100000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '9810')).toBeUndefined();

    // WRX extinguished EXACTLY (GR credit ₩1,300,000 ↔ IV debit ₩1,300,000) — the required invariant.
    expect((await glBalance('2110')) - wrxBefore).toBe(0n);
    // GR/IR open report nets to zero in the PO (document) currency.
    const grIr = await query.grIrByPurchaseOrder(po.id);
    expect(grIr.currency).toBe('USD');
    expect(grIr.lines[0]).toMatchObject({ openQty: '0.000000', grIrOpenAmount: '0.0000' });
    await expectDelta0();
  });

  // 3 — import IV at a LOWER rate (USD weakened) → realized FX GAIN.
  it('books a realized FX gain when the invoice rate is below the GR rate', async () => {
    const wrxBefore = await glBalance('2110');
    const po = await createImportPo('10', '100');
    await receive(po, '10'); // GR rate 1300
    const iv = await invoice(po, '10', '100', '2026-03-16'); // IV rate 1200

    const entry = await journals.getJournal(iv.journalId);
    expect(entry.fxRate).toBe('1200.000000');
    expect(entry.lines.find((l) => l.glAccount === '2110')).toMatchObject({
      drCr: 'D',
      functionalAmount: '1300000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '2100')).toMatchObject({
      drCr: 'C',
      functionalAmount: '1200000.0000',
    });
    // Realized FX gain: ₩100,000 = $1,000 × (1300 − 1200), credit 9810.
    expect(entry.lines.find((l) => l.glAccount === '9810')).toMatchObject({
      drCr: 'C',
      amount: '0.0000',
      functionalAmount: '100000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '9820')).toBeUndefined();
    expect((await glBalance('2110')) - wrxBefore).toBe(0n);
    await expectDelta0();
  });

  // 4 — import IV at the SAME rate as the GR → no realized FX line at all.
  it('posts no realized FX line when the invoice rate equals the GR rate', async () => {
    const wrxBefore = await glBalance('2110');
    const po = await createImportPo('10', '100');
    await receive(po, '10'); // GR rate 1300
    const iv = await invoice(po, '10', '100', '2026-03-08'); // resolves to 1300 (valid_from 03-01)

    const entry = await journals.getJournal(iv.journalId);
    expect(entry.fxRate).toBe('1300.000000');
    expect(entry.lines).toHaveLength(2); // WRX + AP only — no FX gain/loss line
    expect(entry.lines.find((l) => l.glAccount === '9810')).toBeUndefined();
    expect(entry.lines.find((l) => l.glAccount === '9820')).toBeUndefined();
    expect(entry.lines.find((l) => l.glAccount === '2110')).toMatchObject({
      drCr: 'D',
      functionalAmount: '1300000.0000',
    });
    expect((await glBalance('2110')) - wrxBefore).toBe(0n);
    await expectDelta0();
  });

  // 5 — v1 scope guard: a PARTIAL foreign invoice (qty < received) is rejected (full-match only).
  it('rejects a partial foreign-currency invoice (v1 is full-match only)', async () => {
    const po = await createImportPo('10', '100');
    await receive(po, '10');
    await expect(invoice(po, '6', '100', '2026-03-12')).rejects.toThrow(/full received quantity/);
    await expectDelta0();
  });

  // 6 — the USD AP open item the import IV raised is payable by the clearing slice (#13).
  it('lets clearing pay the USD AP open item the import IV created', async () => {
    const po = await createImportPo('5', '200'); // $1,000 gross
    await receive(po, '5');
    const iv = await invoice(po, '5', '200', '2026-03-12'); // rate 1400

    const openBefore = await apInvoices.listOpenItems({ companyCodeId, partnerId: vendorBpId });
    expect(openBefore.items.find((i) => i.journalId === iv.journalId)).toBeDefined();

    const cleared = await clearing.clear({
      companyCodeId,
      journalId: iv.journalId,
      partnerId: vendorBpId,
      postingDate: '2026-03-20', // settlement rate 1200
      postingKey: `clr:${po.docNo}`,
    });
    expect(cleared.status).toBe('POSTED');

    const openAfter = await apInvoices.listOpenItems({ companyCodeId, partnerId: vendorBpId });
    expect(openAfter.items.find((i) => i.journalId === iv.journalId)).toBeUndefined();
    await expectDelta0();
  });

  // 7 — secondary mechanism check: a foreign IV that DOES carry input VAT still balances in both
  // currencies (VAT translates at the invoice rate; WRX relief stays at the GR rate; residue = FX).
  it('handles a foreign IV with input VAT (VAT at the invoice rate, WRX at the GR rate)', async () => {
    const po = await purchaseOrders.create({
      companyCodeId,
      vendorBpId,
      currency: 'USD',
      orderDate: '2026-03-01',
      items: [
        {
          materialId: rawMaterialId,
          plantId,
          storageLocationId: slocId,
          orderedQty: '10',
          unitPrice: '100',
          taxCode: 'A10',
        },
      ],
    });
    const full = await purchaseOrders.getPurchaseOrder(po.purchaseOrderId);
    const itemId = full.items[0]!.id;
    await receive({ id: po.purchaseOrderId, itemId, docNo: po.docNo }, '10');

    const iv = await invoiceVerifications.post({
      companyCodeId,
      purchaseOrderId: po.purchaseOrderId,
      reference: `VINV-VAT-${po.docNo}`,
      postingDate: '2026-03-12',
      documentDate: '2026-03-12',
      currency: 'USD',
      postingKey: `iv:vat:${po.docNo}`,
      items: [{ purchaseOrderItemId: itemId, invoicedQty: '10', invoiceUnitPrice: '100' }],
    });
    // Net $1,000, VAT 10% = $100, gross $1,100 (document currency).
    expect(iv.totalNet).toBe('1000.0000');
    expect(iv.totalTax).toBe('100.0000');
    expect(iv.grandTotal).toBe('1100.0000');

    const entry = await journals.getJournal(iv.journalId);
    // VAT line at the invoice rate: $100 × 1400 = ₩140,000. AP gross $1,100 × 1400 = ₩1,540,000.
    expect(entry.lines.find((l) => l.glAccount === '1350')).toMatchObject({
      drCr: 'D',
      amount: '100.0000',
      functionalAmount: '140000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '2100')).toMatchObject({
      drCr: 'C',
      amount: '1100.0000',
      functionalAmount: '1540000.0000',
    });
    // WRX relief at the GR rate (₩1,300,000); FX loss = (1300000 + 140000) − 1540000 = −100000.
    expect(entry.lines.find((l) => l.glAccount === '2110')).toMatchObject({
      drCr: 'D',
      functionalAmount: '1300000.0000',
    });
    expect(entry.lines.find((l) => l.glAccount === '9820')).toMatchObject({
      drCr: 'D',
      functionalAmount: '100000.0000',
    });
    await expectDelta0();
  });
});
