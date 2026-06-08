import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { OrgStructureService } from '../../src/domains/platform/org-structure/org-structure.service.js';
import { FiscalPeriodService } from '../../src/domains/platform/admin-config/fiscal-period.service.js';
import { NumberingService } from '../../src/domains/platform/numbering/numbering.service.js';
import { OutboxService } from '../../src/domains/platform/outbox/outbox.service.js';
import { DocFlowService } from '../../src/domains/platform/doc-flow/doc-flow.service.js';
import { GlAccountService } from '../../src/domains/master-data/gl-account/gl-account.service.js';
import { DbCurrencyRegistry } from '../../src/domains/master-data/currency/db-currency-registry.js';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import { JournalService } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import { ArInvoiceService } from '../../src/domains/finance-accounting/accounts-receivable/ar-invoice.service.js';
import { ApInvoiceService } from '../../src/domains/finance-accounting/accounts-payable/ap-invoice.service.js';

/**
 * AR/AP invoice posting integration over a real PostgreSQL 16 (Testcontainers, root CLAUDE.md §5.4 —
 * FI postings get integration tests). Proves customer (`DR`) / vendor (`KR`) invoices post through
 * the SAME `JournalService` with recon-account substitution and VAT lines, the D1 per-line→aggregate
 * rounding lands the itemised tax (372, not 371), the A10 input-VAT code posts to 1350, AR/AP draw
 * their own number ranges, open items derive a due date and net to zero on reversal (AR and AP), and
 * the guard rails (missing role, non-recon recon account, wrong tax kind, unconfigured VAT account)
 * reject. SKIP_TESTCONTAINERS=1 skips.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('finance-accounting AR/AP invoices (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let journals: JournalService;
  let partners: BusinessPartnerService;
  let arInvoices: ArInvoiceService;
  let apInvoices: ApInvoiceService;
  let companyCodeId: string;
  let customerBpId: string;
  let vendorBpId: string;
  let noRoleBpId: string;

  const lineOf = (entry: { lines: { glAccount: string }[] }, gl: string) =>
    entry.lines.find((l) => l.glAccount === gl);
  const linesOf = (entry: { lines: { glAccount: string }[] }, gl: string) =>
    entry.lines.filter((l) => l.glAccount === gl);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    const org = new OrgStructureService(db);
    const fiscal = new FiscalPeriodService(db);
    const numbering = new NumberingService(db);
    const glAccounts = new GlAccountService(db);
    const registry = new DbCurrencyRegistry(db);
    partners = new BusinessPartnerService(db);
    journals = new JournalService(
      db,
      fiscal,
      numbering,
      new OutboxService(db),
      new DocFlowService(db),
      glAccounts,
      registry,
    );
    arInvoices = new ArInvoiceService(db, journals, partners, registry);
    apInvoices = new ApInvoiceService(db, journals, partners, registry);

    const company = await org.createCompanyCode({
      code: '1000',
      name: 'Heyday Trading',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    companyCodeId = company.id;
    await fiscal.generateYear(companyCodeId, 2026);

    await db.insert(schema.currency).values([
      {
        code: 'KRW',
        name: 'South Korean Won',
        minorUnit: 0,
        createdBy: 'system',
        updatedBy: 'system',
      },
      { code: 'USD', name: 'US Dollar', minorUnit: 2, createdBy: 'system', updatedBy: 'system' },
    ]);
    await registry.reload();

    for (const range of [
      { object: 'finance.journal_entry', prefix: 'JE-2026-' },
      { object: 'finance.ar_invoice', prefix: 'DR-2026-' },
      { object: 'finance.ap_invoice', prefix: 'KR-2026-' },
    ]) {
      await numbering.defineRange({ scope: '2026', padding: 6, ...range });
    }

    for (const acc of [
      { accountNumber: '1000', name: '현금', accountType: 'ASSET' as const },
      {
        accountNumber: '1100',
        name: '외상매출금',
        accountType: 'ASSET' as const,
        isReconciliation: true,
      },
      { accountNumber: '1350', name: '부가세대급금', accountType: 'ASSET' as const },
      {
        accountNumber: '2100',
        name: '외상매입금',
        accountType: 'LIABILITY' as const,
        isReconciliation: true,
      },
      { accountNumber: '2550', name: '부가세예수금', accountType: 'LIABILITY' as const },
      { accountNumber: '4000', name: '제품매출', accountType: 'REVENUE' as const },
      { accountNumber: '5000', name: '상품매입', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({
        chartOfAccounts: 'KR01',
        isReconciliation: false,
        ...acc,
      });
    }

    await db.insert(schema.taxCode).values([
      {
        code: 'V10',
        name: '매출 10%',
        kind: 'OUTPUT',
        ratePercent: '10',
        glAccount: '2550',
        createdBy: 'system',
        updatedBy: 'system',
      },
      {
        code: 'A10',
        name: '매입 10%',
        kind: 'INPUT',
        ratePercent: '10',
        glAccount: '1350',
        createdBy: 'system',
        updatedBy: 'system',
      },
      {
        code: 'V00',
        name: '영세율',
        kind: 'OUTPUT',
        ratePercent: '0',
        glAccount: '2550',
        createdBy: 'system',
        updatedBy: 'system',
      },
      {
        code: 'VX',
        name: 'GL 미설정',
        kind: 'OUTPUT',
        ratePercent: '10',
        createdBy: 'system',
        updatedBy: 'system',
      },
    ]);

    customerBpId = await partners.ensureBp({
      code: 'C1000',
      name: 'Acme Retail',
      bpType: 'ORGANIZATION',
    });
    await partners.ensureCustomerRole(customerBpId, {
      arReconAccount: '1100',
      paymentTermsDays: 30,
      salesBlock: false,
    });
    vendorBpId = await partners.ensureBp({
      code: 'V2000',
      name: 'Shenzhen Components',
      bpType: 'ORGANIZATION',
    });
    await partners.ensureVendorRole(vendorBpId, {
      apReconAccount: '2100',
      paymentTermsDays: 45,
      purchasingBlock: false,
    });
    noRoleBpId = await partners.ensureBp({
      code: 'P9999',
      name: 'Bare Partner',
      bpType: 'ORGANIZATION',
    });
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1
  it('posts an AR invoice as a DR document: Dr AR recon (+partner) / Cr revenue / Cr output VAT', async () => {
    const posted = await arInvoices.postArInvoice({
      companyCodeId,
      partnerId: customerBpId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'KRW',
      reference: 'INV-0001',
      lines: [{ revenueAccount: '4000', netAmount: '100000', taxCode: 'V10' }],
    });
    expect(posted).toMatchObject({
      status: 'POSTED',
      docType: 'DR',
      totalNet: '100000.0000',
      totalTax: '10000.0000',
      grandTotal: '110000.0000',
    });

    const entry = await journals.getJournal(posted.journalId);
    expect(entry).toMatchObject({ docType: 'DR', docNo: 'DR-2026-000001', status: 'POSTED' });
    expect(entry.lines).toHaveLength(3);
    expect(lineOf(entry, '1100')).toMatchObject({
      lineNo: 1,
      drCr: 'D',
      amount: '110000.0000',
      isReconAccount: true,
      partnerId: customerBpId,
    });
    expect(lineOf(entry, '4000')).toMatchObject({
      drCr: 'C',
      amount: '100000.0000',
      taxCode: 'V10',
    });
    expect(lineOf(entry, '2550')).toMatchObject({
      drCr: 'C',
      amount: '10000.0000',
      taxCode: 'V10',
    });
  });

  // 2 — the locked D1 encoding test.
  it('D1: 3×1,235 @10% rounds per line then aggregates to 372 (a doc-total round would give 371)', async () => {
    const posted = await arInvoices.postArInvoice({
      companyCodeId,
      partnerId: customerBpId,
      postingDate: '2026-03-16',
      documentDate: '2026-03-16',
      currency: 'KRW',
      reference: 'INV-0002',
      lines: [
        { revenueAccount: '4000', netAmount: '1235', taxCode: 'V10' },
        { revenueAccount: '4000', netAmount: '1235', taxCode: 'V10' },
        { revenueAccount: '4000', netAmount: '1235', taxCode: 'V10' },
      ],
    });
    expect(posted).toMatchObject({ totalTax: '372.0000', grandTotal: '4077.0000' });

    const entry = await journals.getJournal(posted.journalId);
    expect(lineOf(entry, '2550')).toMatchObject({ amount: '372.0000' }); // 124 × 3, not 371
    expect(lineOf(entry, '1100')).toMatchObject({ amount: '4077.0000' });
    expect(linesOf(entry, '4000')).toHaveLength(3);
  });

  // 3
  it('aggregates VAT per tax code and drops zero-rated (영세율) VAT lines', async () => {
    const posted = await arInvoices.postArInvoice({
      companyCodeId,
      partnerId: customerBpId,
      postingDate: '2026-03-17',
      documentDate: '2026-03-17',
      currency: 'KRW',
      reference: 'INV-0003',
      lines: [
        { revenueAccount: '4000', netAmount: '10000', taxCode: 'V10' },
        { revenueAccount: '4000', netAmount: '5000', taxCode: 'V00' },
      ],
    });
    expect(posted).toMatchObject({
      totalNet: '15000.0000',
      totalTax: '1000.0000',
      grandTotal: '16000.0000',
    });

    const entry = await journals.getJournal(posted.journalId);
    // recon + 2 revenue + 1 VAT (the 0% line posts no GL VAT line).
    expect(entry.lines).toHaveLength(4);
    expect(linesOf(entry, '2550')).toHaveLength(1);
    expect(lineOf(entry, '2550')).toMatchObject({ amount: '1000.0000', taxCode: 'V10' });
    expect(lineOf(entry, '1100')).toMatchObject({ amount: '16000.0000' });
  });

  // 4
  it('AR open items derive a due date from the invoice date + terms and net to the open balance', async () => {
    const bp = await partners.ensureBp({
      code: 'C2000',
      name: 'Terms Customer',
      bpType: 'ORGANIZATION',
    });
    await partners.ensureCustomerRole(bp, {
      arReconAccount: '1100',
      paymentTermsDays: 15,
      salesBlock: false,
    });
    await arInvoices.postArInvoice({
      companyCodeId,
      partnerId: bp,
      postingDate: '2026-03-10',
      documentDate: '2026-03-10',
      currency: 'KRW',
      reference: 'INV-OI-1',
      lines: [{ revenueAccount: '4000', netAmount: '100000', taxCode: 'V10' }],
    });
    await arInvoices.postArInvoice({
      companyCodeId,
      partnerId: bp,
      postingDate: '2026-03-20',
      documentDate: '2026-03-20',
      currency: 'KRW',
      reference: 'INV-OI-2',
      lines: [{ revenueAccount: '4000', netAmount: '50000', taxCode: 'V10' }],
    });

    const open = await arInvoices.listOpenItems({ companyCodeId, partnerId: bp });
    expect(open.paymentTermsDays).toBe(15);
    expect(open.balance).toEqual({ amount: '165000.0000', currency: 'KRW' }); // 110000 + 55000
    expect(open.items).toHaveLength(2);
    expect(open.items[0]).toMatchObject({
      amount: '110000.0000',
      drCr: 'D',
      dueDate: '2026-03-25',
    });
    expect(open.items[1]).toMatchObject({ amount: '55000.0000', dueDate: '2026-04-04' });
  });

  // 5
  it('rejects an AR invoice for a partner with no customer role', async () => {
    await expect(
      arInvoices.postArInvoice({
        companyCodeId,
        partnerId: noRoleBpId,
        postingDate: '2026-03-15',
        documentDate: '2026-03-15',
        currency: 'KRW',
        reference: 'INV-NOROLE',
        lines: [{ revenueAccount: '4000', netAmount: '1000', taxCode: 'V10' }],
      }),
    ).rejects.toThrow(/no customer/);
  });

  // 6
  it('is idempotent on the posting key: an AR replay returns the same entry, once in the DB', async () => {
    const dto = {
      companyCodeId,
      partnerId: customerBpId,
      postingDate: '2026-03-18',
      documentDate: '2026-03-18',
      currency: 'KRW',
      reference: 'INV-IDEM',
      postingKey: 'itest:ar-idem',
      lines: [{ revenueAccount: '4000', netAmount: '7000', taxCode: 'V10' }],
    };
    const first = await arInvoices.postArInvoice(dto);
    const replay = await arInvoices.postArInvoice(dto);
    expect(replay.journalId).toBe(first.journalId);

    const rows = await db
      .select()
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.postingKey, 'itest:ar-idem'));
    expect(rows).toHaveLength(1);
  });

  // 7
  it('posts an AP invoice as a KR document: Dr expense + Dr input VAT (1350) / Cr AP recon (+partner)', async () => {
    const posted = await apInvoices.postApInvoice({
      companyCodeId,
      partnerId: vendorBpId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'KRW',
      reference: 'BILL-0001',
      lines: [{ expenseAccount: '5000', netAmount: '200000', taxCode: 'A10' }],
    });
    expect(posted).toMatchObject({
      docType: 'KR',
      totalNet: '200000.0000',
      totalTax: '20000.0000',
      grandTotal: '220000.0000',
    });

    const entry = await journals.getJournal(posted.journalId);
    expect(entry).toMatchObject({ docType: 'KR', docNo: 'KR-2026-000001' });
    expect(lineOf(entry, '5000')).toMatchObject({
      drCr: 'D',
      amount: '200000.0000',
      taxCode: 'A10',
    });
    // The A10 input-VAT code posts to 1350 부가세대급금 (the seed gotcha this PR fixes).
    expect(lineOf(entry, '1350')).toMatchObject({
      drCr: 'D',
      amount: '20000.0000',
      taxCode: 'A10',
    });
    expect(lineOf(entry, '2100')).toMatchObject({
      drCr: 'C',
      amount: '220000.0000',
      isReconAccount: true,
      partnerId: vendorBpId,
    });
  });

  // 8
  it('AP open items derive a due date from the invoice date + vendor terms and report the payable', async () => {
    const bp = await partners.ensureBp({
      code: 'V3000',
      name: 'Terms Vendor',
      bpType: 'ORGANIZATION',
    });
    await partners.ensureVendorRole(bp, {
      apReconAccount: '2100',
      paymentTermsDays: 45,
      purchasingBlock: false,
    });
    await apInvoices.postApInvoice({
      companyCodeId,
      partnerId: bp,
      postingDate: '2026-02-10',
      documentDate: '2026-02-10',
      currency: 'KRW',
      reference: 'BILL-OI-1',
      lines: [{ expenseAccount: '5000', netAmount: '300000', taxCode: 'A10' }],
    });

    const open = await apInvoices.listOpenItems({ companyCodeId, partnerId: bp });
    expect(open.paymentTermsDays).toBe(45);
    expect(open.balance).toEqual({ amount: '330000.0000', currency: 'KRW' });
    expect(open.items).toHaveLength(1);
    expect(open.items[0]).toMatchObject({
      amount: '330000.0000',
      drCr: 'C',
      dueDate: '2026-03-27',
    });
  });

  // 9
  it('rejects an AP invoice for a partner with no vendor role', async () => {
    await expect(
      apInvoices.postApInvoice({
        companyCodeId,
        partnerId: noRoleBpId,
        postingDate: '2026-03-15',
        documentDate: '2026-03-15',
        currency: 'KRW',
        reference: 'BILL-NOROLE',
        lines: [{ expenseAccount: '5000', netAmount: '1000', taxCode: 'A10' }],
      }),
    ).rejects.toThrow(/no vendor/);
  });

  // 10
  it('rejects a tax code of the wrong direction on each side (INPUT on AR, OUTPUT on AP)', async () => {
    await expect(
      arInvoices.postArInvoice({
        companyCodeId,
        partnerId: customerBpId,
        postingDate: '2026-03-15',
        documentDate: '2026-03-15',
        currency: 'KRW',
        reference: 'INV-BADKIND',
        lines: [{ revenueAccount: '4000', netAmount: '1000', taxCode: 'A10' }],
      }),
    ).rejects.toThrow(/OUTPUT/);
    await expect(
      apInvoices.postApInvoice({
        companyCodeId,
        partnerId: vendorBpId,
        postingDate: '2026-03-15',
        documentDate: '2026-03-15',
        currency: 'KRW',
        reference: 'BILL-BADKIND',
        lines: [{ expenseAccount: '5000', netAmount: '1000', taxCode: 'V10' }],
      }),
    ).rejects.toThrow(/INPUT/);
  });

  // 11
  it('rejects a tax code with no VAT GL account configured (the NULL gl_account gotcha)', async () => {
    await expect(
      arInvoices.postArInvoice({
        companyCodeId,
        partnerId: customerBpId,
        postingDate: '2026-03-15',
        documentDate: '2026-03-15',
        currency: 'KRW',
        reference: 'INV-NOGL',
        lines: [{ revenueAccount: '4000', netAmount: '1000', taxCode: 'VX' }],
      }),
    ).rejects.toThrow(/no VAT GL account/);
  });

  // 12
  it('keeps DR/KR/JE number ranges independent and reverses an AR invoice to a net-zero open balance', async () => {
    // A manual SA draws from the JE range — untouched by all the DR/KR invoices posted above.
    const manual = await journals.postManual({
      companyCodeId,
      postingDate: '2026-05-05',
      currency: 'KRW',
      reference: 'manual',
      lines: [
        { glAccount: '1000', drCr: 'D', amount: '50000' },
        { glAccount: '4000', drCr: 'C', amount: '50000' },
      ],
    });
    expect((await journals.getJournal(manual.journalId)).docNo).toBe('JE-2026-000001');

    const bp = await partners.ensureBp({
      code: 'C4000',
      name: 'Reverse Me Co',
      bpType: 'ORGANIZATION',
    });
    await partners.ensureCustomerRole(bp, {
      arReconAccount: '1100',
      paymentTermsDays: 0,
      salesBlock: false,
    });
    const inv = await arInvoices.postArInvoice({
      companyCodeId,
      partnerId: bp,
      postingDate: '2026-05-06',
      documentDate: '2026-05-06',
      currency: 'KRW',
      reference: 'INV-REV',
      lines: [{ revenueAccount: '4000', netAmount: '100000', taxCode: 'V10' }],
    });

    const reversal = await journals.reverse(inv.journalId, 'posted in error', '2026-05-10');
    const reversalEntry = await journals.getJournal(reversal.journalId);
    // The AB reversal stays on the JE range (reverse() is unchanged), proving DR/JE counters differ.
    expect(reversalEntry).toMatchObject({ docType: 'AB', docNo: 'JE-2026-000002' });
    expect(lineOf(reversalEntry, '1100')).toMatchObject({ drCr: 'C', amount: '110000.0000' });

    const open = await arInvoices.listOpenItems({ companyCodeId, partnerId: bp });
    expect(open.items).toHaveLength(2); // original Dr + reversal Cr
    expect(open.balance).toEqual({ amount: '0.0000', currency: 'KRW' });
  });

  // 13 — the AP mirror of 12: a reversed vendor invoice nets the payable to zero.
  it('reverses an AP invoice to a net-zero open payable (mirror Cr→Dr on the recon line)', async () => {
    const bp = await partners.ensureBp({
      code: 'V4000',
      name: 'Reverse Me Vendor',
      bpType: 'ORGANIZATION',
    });
    await partners.ensureVendorRole(bp, {
      apReconAccount: '2100',
      paymentTermsDays: 0,
      purchasingBlock: false,
    });
    const bill = await apInvoices.postApInvoice({
      companyCodeId,
      partnerId: bp,
      postingDate: '2026-05-06',
      documentDate: '2026-05-06',
      currency: 'KRW',
      reference: 'BILL-REV',
      lines: [{ expenseAccount: '5000', netAmount: '100000', taxCode: 'A10' }],
    });

    const reversal = await journals.reverse(bill.journalId, 'posted in error', '2026-05-12');
    const reversalEntry = await journals.getJournal(reversal.journalId);
    expect(reversalEntry).toMatchObject({ docType: 'AB' });
    // Original AP recon was Cr; the reversal mirrors it to Dr, same gross.
    expect(lineOf(reversalEntry, '2100')).toMatchObject({ drCr: 'D', amount: '110000.0000' });

    const open = await apInvoices.listOpenItems({ companyCodeId, partnerId: bp });
    expect(open.items).toHaveLength(2); // original Cr + reversal Dr
    expect(open.balance).toEqual({ amount: '0.0000', currency: 'KRW' });
  });

  // 14 — a role cannot point at a non-reconciliation account (else its lines never reach the subledger).
  it('rejects attaching a customer/vendor role to a non-reconciliation account', async () => {
    const bp = await partners.ensureBp({
      code: 'C5000',
      name: 'Misconfig Co',
      bpType: 'ORGANIZATION',
    });
    await expect(
      partners.addCustomerRole(bp, { arReconAccount: '4000', salesBlock: false }),
    ).rejects.toThrow(/not a reconciliation account/);
    await expect(
      partners.addVendorRole(bp, { apReconAccount: '4000', purchasingBlock: false }),
    ).rejects.toThrow(/not a reconciliation account/);
  });
});
