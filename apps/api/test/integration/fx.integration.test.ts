import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { OrgStructureService } from '../../src/domains/platform/org-structure/org-structure.service.js';
import { FiscalPeriodService } from '../../src/domains/platform/admin-config/fiscal-period.service.js';
import { AccountDeterminationService } from '../../src/domains/platform/admin-config/account-determination.service.js';
import { NumberingService } from '../../src/domains/platform/numbering/numbering.service.js';
import { OutboxService } from '../../src/domains/platform/outbox/outbox.service.js';
import { DocFlowService } from '../../src/domains/platform/doc-flow/doc-flow.service.js';
import { GlAccountService } from '../../src/domains/master-data/gl-account/gl-account.service.js';
import { CurrencyService } from '../../src/domains/master-data/currency/currency.service.js';
import { DbCurrencyRegistry } from '../../src/domains/master-data/currency/db-currency-registry.js';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import { JournalService } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import { ArInvoiceService } from '../../src/domains/finance-accounting/accounts-receivable/ar-invoice.service.js';
import { ApInvoiceService } from '../../src/domains/finance-accounting/accounts-payable/ap-invoice.service.js';

/**
 * FX (cross-currency) translation integration over a real PostgreSQL 16 (Testcontainers, root
 * CLAUDE.md §5.4 — FX translation is a mandatory calc with FI integration tests). Runs migrations
 * 0001..0009, then proves the FX slice end-to-end through the SINGLE writer `JournalService.post()`:
 *
 *  - a foreign manual GL entry translates each line on the DOCUMENT date and ties out in KRW;
 *  - per-line rounding injects ONE FX_ROUNDING (9800, currency=null) line for the functional residue;
 *  - the manual fx-rate override is honoured, and is rejected on a functional-currency entry;
 *  - the KRW==KRW path stays byte-identical (fx_rate NULL, functional_amount == amount);
 *  - AR (DR) and AP (KR) foreign invoices gain FX for free through the same post();
 *  - a missing master rate is surfaced;
 *  - the migration-0009 functional-balance trigger rejects a doc-balanced-but-functionally-unbalanced
 *    raw write; and reverse() stays exact in both currencies (rounding line included).
 *
 * Set SKIP_TESTCONTAINERS=1 to skip where Docker is absent.
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('finance-accounting FX translation (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let fiscal: FiscalPeriodService;
  let journals: JournalService;
  let arInvoices: ArInvoiceService;
  let apInvoices: ApInvoiceService;
  let companyCodeId: string;
  let fiscalYearId: string;
  let customerBpId: string;
  let vendorBpId: string;

  const lineOf = (entry: { lines: { glAccount: string }[] }, gl: string) =>
    entry.lines.find((l) => l.glAccount === gl);
  const linesOf = (entry: { lines: { glAccount: string }[] }, gl: string) =>
    entry.lines.filter((l) => l.glAccount === gl);
  /** Σ functional_amount signed by side — zero iff the entry ties out in the functional currency. */
  const functionalNet = (entry: { lines: { drCr: string; functionalAmount: string }[] }) =>
    entry.lines.reduce((n, l) => n + (l.drCr === 'D' ? 1 : -1) * Number(l.functionalAmount), 0);

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    const org = new OrgStructureService(db);
    fiscal = new FiscalPeriodService(db);
    const numbering = new NumberingService(db);
    const glAccounts = new GlAccountService(db);
    const registry = new DbCurrencyRegistry(db);
    const currencies = new CurrencyService(db, registry);
    const accountDet = new AccountDeterminationService(db);
    const partners = new BusinessPartnerService(db);
    journals = new JournalService(
      db,
      fiscal,
      numbering,
      new OutboxService(db),
      new DocFlowService(db),
      glAccounts,
      registry,
      currencies,
      accountDet,
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
    fiscalYearId = await fiscal.generateYear(companyCodeId, 2026);

    for (const cur of [
      { code: 'KRW', name: 'South Korean Won', minorUnit: 0 },
      { code: 'USD', name: 'US Dollar', minorUnit: 2 },
      { code: 'EUR', name: 'Euro', minorUnit: 2 },
      // CNY exists as a currency but has NO fx rate — exercises the missing-rate path.
      { code: 'CNY', name: 'Chinese Yuan', minorUnit: 2 },
    ]) {
      await currencies.ensureCurrency(cur);
    }
    // USD has two effective rates; the document-date one (1300, not the posting-date 1400) must win.
    for (const fx of [
      { fromCurrency: 'USD', toCurrency: 'KRW', validFrom: '2026-01-01', rate: '1300.000000' },
      { fromCurrency: 'USD', toCurrency: 'KRW', validFrom: '2026-06-01', rate: '1400.000000' },
      { fromCurrency: 'EUR', toCurrency: 'KRW', validFrom: '2026-01-01', rate: '1450.000000' },
    ]) {
      await currencies.ensureFxRate({ rateType: 'M', ...fx });
    }

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
      // FX_ROUNDING plug — currency intentionally null (any) per FX caution #1.
      { accountNumber: '9800', name: '외환차손익', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({
        chartOfAccounts: 'KR01',
        isReconciliation: false,
        ...acc,
      });
    }

    await accountDet.defineRule({
      chartOfAccounts: 'KR01',
      transactionKey: 'FX_ROUNDING',
      glAccount: '9800',
    });

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
    ]);

    customerBpId = await partners.ensureBp({
      code: 'C1000',
      name: 'Acme USA',
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
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1 — a clean foreign manual GL entry: every line translated, header rate stamped, ties out in KRW.
  it('translates a foreign manual GL entry into the functional currency (USD @ document-date rate)', async () => {
    // documentDate 2026-03-15 → USD 1300; postingDate 2026-07-10 would map to 1400 if it (wrongly)
    // drove translation. Asserting 130,000 proves the DOCUMENT date is the translation date.
    const posted = await journals.postManual({
      companyCodeId,
      postingDate: '2026-07-10',
      documentDate: '2026-03-15',
      currency: 'USD',
      reference: 'fx-manual',
      postingKey: 'itest:fx-manual',
      lines: [
        { glAccount: '5000', drCr: 'D', amount: '100.00' },
        { glAccount: '1000', drCr: 'C', amount: '100.00' },
      ],
    });

    const entry = await journals.getJournal(posted.journalId);
    expect(entry).toMatchObject({ currency: 'USD', functionalCurrency: 'KRW' });
    expect(Number(entry.fxRate)).toBe(1300);
    expect(entry.fxRate).toBe('1300.000000'); // master rate stamped at NUMERIC(18,6) scale
    expect(entry.lines).toHaveLength(2); // exact (1300 is a whole won per cent) → no rounding line
    expect(lineOf(entry, '5000')).toMatchObject({
      drCr: 'D',
      amount: '100.0000',
      currency: 'USD',
      functionalAmount: '130000.0000',
      functionalCurrency: 'KRW',
    });
    expect(lineOf(entry, '1000')).toMatchObject({
      amount: '100.0000',
      functionalAmount: '130000.0000',
    });
    expect(functionalNet(entry)).toBe(0);
  });

  // 2 — per-line rounding leaves a functional residue → one FX_ROUNDING line closes it (EUR @ 1450).
  it('injects an FX_ROUNDING line for the per-line functional residue', async () => {
    // 33.33 + 33.33 + 33.34 EUR @ 1450 → 48,329 + 48,329 + 48,343 = 145,001 vs cash 145,000 → +1 KRW.
    const posted = await journals.postManual({
      companyCodeId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'EUR',
      reference: 'fx-rounding',
      postingKey: 'itest:fx-rounding',
      lines: [
        { glAccount: '5000', drCr: 'D', amount: '33.33' },
        { glAccount: '5000', drCr: 'D', amount: '33.33' },
        { glAccount: '5000', drCr: 'D', amount: '33.34' },
        { glAccount: '1000', drCr: 'C', amount: '100.00' },
      ],
    });

    const entry = await journals.getJournal(posted.journalId);
    expect(entry.lines).toHaveLength(5); // 4 document lines + 1 rounding plug
    expect(Number(entry.fxRate)).toBe(1450);

    const expense = linesOf(entry, '5000');
    expect(expense).toHaveLength(3);
    expect(expense.map((l) => l.functionalAmount).sort()).toEqual([
      '48329.0000',
      '48329.0000',
      '48343.0000',
    ]);

    // The plug: 0 in the document currency, the 1-KRW residue in the functional currency, short side.
    expect(lineOf(entry, '9800')).toMatchObject({
      drCr: 'C',
      amount: '0.0000',
      currency: 'EUR',
      functionalAmount: '1.0000',
      functionalCurrency: 'KRW',
      isReconAccount: false,
    });
    // Document currency balances (the 0 plug contributes nothing); functional currency ties out.
    expect(functionalNet(entry)).toBe(0);
  });

  // 3 — the manual fx-rate override is honoured over the master rate.
  it('honours a manual fx-rate override', async () => {
    const posted = await journals.postManual({
      companyCodeId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'USD',
      reference: 'fx-override',
      postingKey: 'itest:fx-override',
      fxRate: '1325.5', // not the 1300 master rate
      lines: [
        { glAccount: '5000', drCr: 'D', amount: '100.00' },
        { glAccount: '1000', drCr: 'C', amount: '100.00' },
      ],
    });

    const entry = await journals.getJournal(posted.journalId);
    expect(Number(entry.fxRate)).toBe(1325.5);
    // The override is stamped verbatim at the NUMERIC(18,6) master scale (not the 1300 master rate).
    expect(entry.fxRate).toBe('1325.500000');
    expect(lineOf(entry, '5000')).toMatchObject({ functionalAmount: '132550.0000' });
    expect(functionalNet(entry)).toBe(0);
  });

  // 4 — an override on a functional-currency (KRW) entry is rejected.
  it('rejects an fx-rate override on a functional-currency entry', async () => {
    await expect(
      journals.postManual({
        companyCodeId,
        postingDate: '2026-03-15',
        currency: 'KRW',
        reference: 'fx-bad-override',
        postingKey: 'itest:fx-bad-override',
        fxRate: '1300',
        lines: [
          { glAccount: '5000', drCr: 'D', amount: '1000' },
          { glAccount: '1000', drCr: 'C', amount: '1000' },
        ],
      }),
    ).rejects.toThrow(/fx rate override/);
  });

  // 5 — KRW regression: a functional-currency entry is byte-identical to the pre-FX path.
  it('keeps the KRW==KRW path byte-identical (fx_rate NULL, functional_amount == amount)', async () => {
    const posted = await journals.postManual({
      companyCodeId,
      postingDate: '2026-03-15',
      currency: 'KRW',
      reference: 'krw',
      postingKey: 'itest:krw',
      lines: [
        { glAccount: '1000', drCr: 'D', amount: '50000' },
        { glAccount: '4000', drCr: 'C', amount: '50000' },
      ],
    });
    const entry = await journals.getJournal(posted.journalId);
    expect(entry.fxRate).toBeNull();
    expect(entry.lines).toHaveLength(2);
    for (const l of entry.lines) {
      expect(l.amount).toBe('50000.0000');
      expect(l.functionalAmount).toBe('50000.0000');
      expect(l.functionalCurrency).toBe('KRW');
    }
  });

  // 6 — a foreign AR invoice gains FX through the same post() (master rate, no override).
  it('posts a foreign AR (DR) invoice and translates the gross/revenue/VAT into KRW', async () => {
    const posted = await arInvoices.postArInvoice({
      companyCodeId,
      partnerId: customerBpId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'USD',
      reference: 'INV-USD-1',
      lines: [{ revenueAccount: '4000', netAmount: '100.00', taxCode: 'V10' }],
    });
    expect(posted).toMatchObject({ docType: 'DR', grandTotal: '110.0000' });

    const entry = await journals.getJournal(posted.journalId);
    expect(entry).toMatchObject({ currency: 'USD', functionalCurrency: 'KRW' });
    expect(Number(entry.fxRate)).toBe(1300);
    // Gross 110 / revenue 100 / VAT 10 USD → 143,000 / 130,000 / 13,000 KRW (exact at 1300).
    expect(lineOf(entry, '1100')).toMatchObject({
      drCr: 'D',
      amount: '110.0000',
      functionalAmount: '143000.0000',
      partnerId: customerBpId,
      isReconAccount: true,
    });
    expect(lineOf(entry, '4000')).toMatchObject({
      amount: '100.0000',
      functionalAmount: '130000.0000',
    });
    expect(lineOf(entry, '2550')).toMatchObject({
      amount: '10.0000',
      functionalAmount: '13000.0000',
    });
    expect(functionalNet(entry)).toBe(0);
  });

  // 7 — a foreign AP invoice mirrors AR: expense + input VAT debit, AP recon credit, all translated.
  it('posts a foreign AP (KR) invoice and translates the expense/VAT/payable into KRW', async () => {
    const posted = await apInvoices.postApInvoice({
      companyCodeId,
      partnerId: vendorBpId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'USD',
      reference: 'BILL-USD-1',
      lines: [{ expenseAccount: '5000', netAmount: '100.00', taxCode: 'A10' }],
    });
    expect(posted).toMatchObject({ docType: 'KR', grandTotal: '110.0000' });

    const entry = await journals.getJournal(posted.journalId);
    expect(Number(entry.fxRate)).toBe(1300);
    expect(lineOf(entry, '5000')).toMatchObject({ drCr: 'D', functionalAmount: '130000.0000' });
    expect(lineOf(entry, '1350')).toMatchObject({ drCr: 'D', functionalAmount: '13000.0000' });
    expect(lineOf(entry, '2100')).toMatchObject({
      drCr: 'C',
      amount: '110.0000',
      functionalAmount: '143000.0000',
      partnerId: vendorBpId,
    });
    expect(functionalNet(entry)).toBe(0);
  });

  // 8 — a missing master rate (CNY has none) is surfaced, and nothing is written.
  it('rejects a foreign entry with no effective master rate', async () => {
    const before = await journals.countJournals({ page: 1, pageSize: 1 });
    await expect(
      journals.postManual({
        companyCodeId,
        postingDate: '2026-03-15',
        documentDate: '2026-03-15',
        currency: 'CNY',
        reference: 'fx-norate',
        postingKey: 'itest:fx-norate',
        lines: [
          { glAccount: '5000', drCr: 'D', amount: '100.00' },
          { glAccount: '1000', drCr: 'C', amount: '100.00' },
        ],
      }),
    ).rejects.toThrow(/no M rate for CNY/);
    expect(await journals.countJournals({ page: 1, pageSize: 1 })).toBe(before);
  });

  // 9 — the 0009 DB backstop: a doc-balanced but functionally-unbalanced raw write is rejected.
  it('DB backstop: the 0009 deferred trigger rejects a functional imbalance at COMMIT', async () => {
    const periods = await fiscal.listPeriods(fiscalYearId);
    const march = periods.find((p) => p.periodNo === 3)!;
    await expect(
      db.transaction(async (tx) => {
        const [h] = await tx
          .insert(schema.journalEntry)
          .values({
            docType: 'SA',
            docNo: 'RAW-FX-1',
            status: 'POSTED',
            postingKey: 'raw:fx-unbalanced',
            companyCodeId,
            postingDate: '2026-03-10',
            documentDate: '2026-03-10',
            fiscalYear: 2026,
            periodNo: 3,
            fiscalPeriodId: march.id,
            currency: 'USD',
            functionalCurrency: 'KRW',
            fxRate: '1300.000000',
            reference: 'raw',
            createdBy: 'system',
            updatedBy: 'system',
          })
          .returning({ id: schema.journalEntry.id });
        // Balanced in USD (10 = 10) but NOT in KRW (13,500 ≠ 13,000) → 0009 fires at COMMIT.
        await tx.insert(schema.journalLine).values([
          {
            journalEntryId: h!.id,
            lineNo: 1,
            glAccount: '5000',
            drCr: 'D',
            amount: '10.0000',
            currency: 'USD',
            functionalAmount: '13500.0000',
            functionalCurrency: 'KRW',
            createdBy: 'system',
            updatedBy: 'system',
          },
          {
            journalEntryId: h!.id,
            lineNo: 2,
            glAccount: '1000',
            drCr: 'C',
            amount: '10.0000',
            currency: 'USD',
            functionalAmount: '13000.0000',
            functionalCurrency: 'KRW',
            createdBy: 'system',
            updatedBy: 'system',
          },
        ]);
      }),
    ).rejects.toThrow(/functionally unbalanced/);
  });

  // 10 — reverse() stays exact in BOTH currencies, rounding line included (no re-translation).
  it('reverses an FX entry with a rounding line to a net-zero in both currencies', async () => {
    const posted = await journals.postManual({
      companyCodeId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'EUR',
      reference: 'fx-rev',
      postingKey: 'itest:fx-rev',
      lines: [
        { glAccount: '5000', drCr: 'D', amount: '33.33' },
        { glAccount: '5000', drCr: 'D', amount: '33.33' },
        { glAccount: '5000', drCr: 'D', amount: '33.34' },
        { glAccount: '1000', drCr: 'C', amount: '100.00' },
      ],
    });
    const original = await journals.getJournal(posted.journalId);
    expect(original.lines).toHaveLength(5);

    const reversal = await journals.reverse(posted.journalId, 'posted in error', '2026-04-20');
    const mirror = await journals.getJournal(reversal.journalId);
    expect(mirror).toMatchObject({ docType: 'AB', currency: 'EUR', functionalCurrency: 'KRW' });
    expect(mirror.lines).toHaveLength(5);
    // The rounding line is mirrored verbatim with its side flipped (C → D), functional amount kept.
    expect(lineOf(mirror, '9800')).toMatchObject({
      drCr: 'D',
      amount: '0.0000',
      functionalAmount: '1.0000',
      functionalCurrency: 'KRW',
    });
    expect(functionalNet(mirror)).toBe(0); // 0009 passed on the reversal too
    // Original + reversal net to zero per account in the functional currency.
    expect(functionalNet(original) + functionalNet(mirror)).toBe(0);
  });

  // 11 — the OTHER plug direction: a credit-heavy residue (< 0) puts the FX_ROUNDING line on the DEBIT
  // side with a positive functional magnitude (mirror of test #2, exercising translateLines' 'D' branch).
  it('injects a DEBIT-side FX_ROUNDING line when the functional credit side rounds up more', async () => {
    // Dr cash 100.00 EUR → 145,000; Cr 33.33/33.33/33.34 EUR → 48,329+48,329+48,343 = 145,001 → −1.
    const posted = await journals.postManual({
      companyCodeId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'EUR',
      reference: 'fx-rounding-debit',
      postingKey: 'itest:fx-rounding-debit',
      lines: [
        { glAccount: '1000', drCr: 'D', amount: '100.00' },
        { glAccount: '4000', drCr: 'C', amount: '33.33' },
        { glAccount: '4000', drCr: 'C', amount: '33.33' },
        { glAccount: '4000', drCr: 'C', amount: '33.34' },
      ],
    });

    const entry = await journals.getJournal(posted.journalId);
    expect(entry.lines).toHaveLength(5);
    expect(lineOf(entry, '9800')).toMatchObject({
      drCr: 'D', // short side is now the debit
      amount: '0.0000',
      currency: 'EUR',
      functionalAmount: '1.0000', // |residue|, positive magnitude (never negative)
      functionalCurrency: 'KRW',
    });
    expect(functionalNet(entry)).toBe(0);
  });

  // 12 — LOCKED decision 3: a manual fx-rate OVERRIDE that produces a residue still gets the
  // FX_ROUNDING plug + functional tie-out (the override path shares translateLines' residue branch).
  it('applies the FX_ROUNDING plug on an override-rate entry that leaves a residue', async () => {
    // Override 1350 (not a USD master rate): 33.33/33.33/33.34 → 44,996+44,996+45,009 = 135,001 vs
    // cash 135,000 → +1 KRW credit plug.
    const posted = await journals.postManual({
      companyCodeId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'USD',
      reference: 'fx-override-residue',
      postingKey: 'itest:fx-override-residue',
      fxRate: '1350',
      lines: [
        { glAccount: '5000', drCr: 'D', amount: '33.33' },
        { glAccount: '5000', drCr: 'D', amount: '33.33' },
        { glAccount: '5000', drCr: 'D', amount: '33.34' },
        { glAccount: '1000', drCr: 'C', amount: '100.00' },
      ],
    });

    const entry = await journals.getJournal(posted.journalId);
    expect(entry.fxRate).toBe('1350.000000');
    expect(entry.lines).toHaveLength(5);
    expect(lineOf(entry, '9800')).toMatchObject({
      drCr: 'C',
      amount: '0.0000',
      functionalAmount: '1.0000',
      functionalCurrency: 'KRW',
    });
    expect(functionalNet(entry)).toBe(0);
  });

  // 13 — a foreign invoice (multi-line, fractional rate) drives a real residue through the AR path:
  // the gross recon line and the per-net/VAT lines translate independently and the plug ties them out.
  it('posts a foreign AR invoice whose per-line translation needs an FX_ROUNDING plug', async () => {
    // EUR @ 1450: net 33.33/33.33/33.34 V10 → per-line VAT 3.33×3 = 9.99; gross 109.99.
    // Functional: recon 109.99→159,486 (D); revenue 48,329+48,329+48,343 + VAT 9.99→14,486 = 159,487 (C)
    // → residue −1 → a DEBIT plug of 1 KRW alongside the partner recon line.
    const posted = await arInvoices.postArInvoice({
      companyCodeId,
      partnerId: customerBpId,
      postingDate: '2026-03-15',
      documentDate: '2026-03-15',
      currency: 'EUR',
      reference: 'INV-EUR-RND',
      lines: [
        { revenueAccount: '4000', netAmount: '33.33', taxCode: 'V10' },
        { revenueAccount: '4000', netAmount: '33.33', taxCode: 'V10' },
        { revenueAccount: '4000', netAmount: '33.34', taxCode: 'V10' },
      ],
    });
    expect(posted).toMatchObject({ docType: 'DR', grandTotal: '109.9900' });

    const entry = await journals.getJournal(posted.journalId);
    expect(Number(entry.fxRate)).toBe(1450);
    expect(entry.lines).toHaveLength(6); // recon + 3 revenue + 1 VAT + 1 FX_ROUNDING plug
    expect(lineOf(entry, '1100')).toMatchObject({
      drCr: 'D',
      amount: '109.9900',
      functionalAmount: '159486.0000',
      partnerId: customerBpId,
      isReconAccount: true,
    });
    expect(lineOf(entry, '2550')).toMatchObject({
      amount: '9.9900',
      functionalAmount: '14486.0000',
    });
    expect(lineOf(entry, '9800')).toMatchObject({
      drCr: 'D',
      amount: '0.0000',
      currency: 'EUR',
      functionalAmount: '1.0000',
    });
    expect(functionalNet(entry)).toBe(0);
  });

  // 14 — FX caution A is load-bearing: a currency-PINNED FX_ROUNDING account rejects the 0-amount
  // foreign plug line (it MUST be currency=null). Re-points the rule, then restores it.
  it('rejects a residue-bearing FX entry when the FX_ROUNDING account is currency-pinned', async () => {
    const accountDet = new AccountDeterminationService(db);
    await db.insert(schema.glAccount).values({
      chartOfAccounts: 'KR01',
      accountNumber: '9801',
      name: '외환차손익(USD고정)',
      accountType: 'EXPENSE',
      currency: 'USD', // pinned — the wrong way to configure FX_ROUNDING
      isReconciliation: false,
      createdBy: 'system',
      updatedBy: 'system',
    });
    await accountDet.defineRule({
      chartOfAccounts: 'KR01',
      transactionKey: 'FX_ROUNDING',
      glAccount: '9801',
    });
    try {
      await expect(
        journals.postManual({
          companyCodeId,
          postingDate: '2026-03-15',
          documentDate: '2026-03-15',
          currency: 'EUR',
          reference: 'fx-pinned',
          postingKey: 'itest:fx-pinned',
          lines: [
            { glAccount: '5000', drCr: 'D', amount: '33.33' },
            { glAccount: '5000', drCr: 'D', amount: '33.33' },
            { glAccount: '5000', drCr: 'D', amount: '33.34' },
            { glAccount: '1000', drCr: 'C', amount: '100.00' },
          ],
        }),
      ).rejects.toThrow(/is fixed to/);
    } finally {
      // Restore the correct (currency=null) rounding account so the rule is left as seeded.
      await accountDet.defineRule({
        chartOfAccounts: 'KR01',
        transactionKey: 'FX_ROUNDING',
        glAccount: '9800',
      });
    }
  });
});
