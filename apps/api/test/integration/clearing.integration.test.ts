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
import { NumberingService } from '../../src/domains/platform/numbering/numbering.service.js';
import { OutboxService } from '../../src/domains/platform/outbox/outbox.service.js';
import { DocFlowService } from '../../src/domains/platform/doc-flow/doc-flow.service.js';
import { GlAccountService } from '../../src/domains/master-data/gl-account/gl-account.service.js';
import { DbCurrencyRegistry } from '../../src/domains/master-data/currency/db-currency-registry.js';
import { CurrencyService } from '../../src/domains/master-data/currency/currency.service.js';
import { AccountDeterminationService } from '../../src/domains/platform/admin-config/account-determination.service.js';
import { BusinessPartnerService } from '../../src/domains/master-data/business-partner/business-partner.service.js';
import {
  DOC_FLOW_TYPE,
  JournalService,
} from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import {
  JOURNAL_EVENT_NAMESPACE,
  uuidV5,
} from '../../src/domains/finance-accounting/general-ledger/posting-id.js';
import { ArInvoiceService } from '../../src/domains/finance-accounting/accounts-receivable/ar-invoice.service.js';
import { ApInvoiceService } from '../../src/domains/finance-accounting/accounts-payable/ap-invoice.service.js';
import { ClearingService } from '../../src/domains/finance-accounting/clearing/clearing.service.js';

/**
 * Payment/clearing integration over a real PostgreSQL 16 (Testcontainers, root CLAUDE.md §5.4 — FI
 * postings get integration tests). Proves manual FULL clearing of open AR/AP items through the SAME
 * `JournalService`: open balances net to zero and the cleared item AND the clearing's own offsetting
 * recon line drop out of `listOpenItems`; foreign-currency clearing recognizes realized FX gain/loss
 * (recon closes at the original invoice-date functional value, cash at the settlement-date rate, the
 * difference to REALIZED_FX_GAIN/LOSS via account_determination — distinct from the FX_ROUNDING KDR
 * plug) keeping both document- and functional-currency balance; exact-rate clearing books no FX;
 * reset-clearing (reverse of the clearing) re-opens the item and nets to zero in both currencies;
 * idempotency, the partial-clear rejection, and the already-cleared conflict hold. The whole slice
 * adds NO migration. SKIP_TESTCONTAINERS=1 skips.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('finance-accounting clearing/payment (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let journals: JournalService;
  let partners: BusinessPartnerService;
  let arInvoices: ArInvoiceService;
  let apInvoices: ApInvoiceService;
  let clearing: ClearingService;
  let accountDet: AccountDeterminationService;
  let companyCodeId: string;

  const lineOf = (entry: { lines: { glAccount: string }[] }, gl: string) =>
    entry.lines.find((l) => l.glAccount === gl);
  /** Σ functional_amount signed by side — zero iff the entry ties out in the functional currency. */
  const functionalNet = (entry: { lines: { drCr: string; functionalAmount: string }[] }) =>
    entry.lines.reduce((n, l) => n + (l.drCr === 'D' ? 1 : -1) * Number(l.functionalAmount), 0);

  /** Post a customer with an AR role and return its BP id (fresh per test → isolated open items). */
  const newCustomer = (code: string) =>
    partners
      .ensureBp({ code, name: code, bpType: 'ORGANIZATION' })
      .then(async (id) => {
        await partners.ensureCustomerRole(id, {
          arReconAccount: '1100',
          paymentTermsDays: 30,
          salesBlock: false,
        });
        return id;
      });
  const newVendor = (code: string) =>
    partners.ensureBp({ code, name: code, bpType: 'ORGANIZATION' }).then(async (id) => {
      await partners.ensureVendorRole(id, {
        apReconAccount: '2100',
        paymentTermsDays: 45,
        purchasingBlock: false,
      });
      return id;
    });

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
    const currencies = new CurrencyService(db, registry);
    accountDet = new AccountDeterminationService(db);
    partners = new BusinessPartnerService(db);
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
    clearing = new ClearingService(db, journals, accountDet, currencies, registry);

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
      { code: 'KRW', name: 'South Korean Won', minorUnit: 0, createdBy: 'system', updatedBy: 'system' },
      { code: 'USD', name: 'US Dollar', minorUnit: 2, createdBy: 'system', updatedBy: 'system' },
    ]);
    await registry.reload();

    // USD→KRW: three effective rates so the DOCUMENT date (invoice) and the SETTLEMENT date (clearing)
    // resolve to different rates — 1300 from Jan, 1400 from Jun (gain), 1200 from Sep (loss).
    for (const fx of [
      { validFrom: '2026-01-01', rate: '1300.000000' },
      { validFrom: '2026-06-01', rate: '1400.000000' },
      { validFrom: '2026-09-01', rate: '1200.000000' },
    ]) {
      await currencies.ensureFxRate({ rateType: 'M', fromCurrency: 'USD', toCurrency: 'KRW', ...fx });
    }

    for (const range of [
      { object: 'finance.journal_entry', prefix: 'JE-2026-' },
      { object: 'finance.ar_invoice', prefix: 'DR-2026-' },
      { object: 'finance.ap_invoice', prefix: 'KR-2026-' },
      { object: 'finance.ar_clearing', prefix: 'DZ-2026-' },
      { object: 'finance.ap_clearing', prefix: 'KZ-2026-' },
    ]) {
      await numbering.defineRange({ scope: '2026', padding: 6, ...range });
    }

    for (const acc of [
      { accountNumber: '1000', name: '현금', accountType: 'ASSET' as const },
      { accountNumber: '1010', name: '현금클리어링', accountType: 'ASSET' as const },
      { accountNumber: '1100', name: '외상매출금', accountType: 'ASSET' as const, isReconciliation: true },
      { accountNumber: '2100', name: '외상매입금', accountType: 'LIABILITY' as const, isReconciliation: true },
      { accountNumber: '4000', name: '제품매출', accountType: 'REVENUE' as const },
      { accountNumber: '5000', name: '상품매입', accountType: 'EXPENSE' as const },
      { accountNumber: '9800', name: '외환차손익', accountType: 'EXPENSE' as const },
      { accountNumber: '9810', name: '외환차익', accountType: 'REVENUE' as const },
      { accountNumber: '9820', name: '외환차손', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({ chartOfAccounts: 'KR01', isReconciliation: false, ...acc });
    }

    for (const rule of [
      { transactionKey: 'FX_ROUNDING', glAccount: '9800' },
      { transactionKey: 'BANK_CLEARING', glAccount: '1010' },
      { transactionKey: 'REALIZED_FX_GAIN', glAccount: '9810' },
      { transactionKey: 'REALIZED_FX_LOSS', glAccount: '9820' },
    ]) {
      await accountDet.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  /** Post a single-line KRW AR invoice (no tax) → recon gross == net. Returns its journal id. */
  const arInvoiceKrw = async (bp: string, net: string, ref: string, date = '2026-03-10') =>
    (
      await arInvoices.postArInvoice({
        companyCodeId,
        partnerId: bp,
        postingDate: date,
        documentDate: date,
        currency: 'KRW',
        reference: ref,
        lines: [{ revenueAccount: '4000', netAmount: net }],
      })
    ).journalId;

  /** Post a single-line USD AR invoice (no tax) on the document date → recon gross == net USD. */
  const arInvoiceUsd = async (bp: string, net: string, ref: string, date = '2026-02-10') =>
    (
      await arInvoices.postArInvoice({
        companyCodeId,
        partnerId: bp,
        postingDate: date,
        documentDate: date,
        currency: 'USD',
        reference: ref,
        lines: [{ revenueAccount: '4000', netAmount: net }],
      })
    ).journalId;

  // 1
  it('clears an open AR invoice in full against cash: balance nets to zero, the clearing line is NOT open, CLEARS edge + event', async () => {
    const bp = await newCustomer('C-CLR-1');
    const invId = await arInvoiceKrw(bp, '100000', 'INV-CLR-1');

    const result = await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-03-20',
      postingKey: 'itest:clr-ar-1',
    });
    expect(result).toMatchObject({
      status: 'POSTED',
      docType: 'DZ',
      side: 'AR',
      reconAccount: '1100',
      bankAccount: '1010',
      currency: 'KRW',
      realizedFx: null,
    });

    const entry = await journals.getJournal(result.journalId);
    expect(entry).toMatchObject({ docType: 'DZ', docNo: 'DZ-2026-000001', status: 'POSTED' });
    expect(entry.lines).toHaveLength(2);
    expect(lineOf(entry, '1010')).toMatchObject({ drCr: 'D', amount: '100000.0000' });
    expect(lineOf(entry, '1100')).toMatchObject({ drCr: 'C', amount: '100000.0000', partnerId: bp });
    expect(functionalNet(entry)).toBe(0);

    // The cleared invoice AND the clearing's own offsetting recon line are both excluded → 0 open.
    const open = await arInvoices.listOpenItems({ companyCodeId, partnerId: bp });
    expect(open.items).toHaveLength(0);
    expect(open.balance).toBeNull();

    // CLEARS doc-flow edge (clearing → invoice) + the cleared outbox event, both in the posting tx.
    const docFlow = new DocFlowService(db);
    const edges = await docFlow.forward(DOC_FLOW_TYPE, result.journalId);
    expect(edges).toContainEqual(
      expect.objectContaining({ targetId: invId, relType: 'CLEARS', targetType: DOC_FLOW_TYPE }),
    );
    const [ev] = await db
      .select()
      .from(schema.outbox)
      .where(eq(schema.outbox.eventId, uuidV5(`${companyCodeId}:itest:clr-ar-1`, JOURNAL_EVENT_NAMESPACE)));
    expect(ev).toMatchObject({ eventType: 'finance.journal.cleared' });
  });

  // 2
  it('clears an open AP invoice in full against cash (mirror): payable nets to zero, clearing line not open', async () => {
    const bp = await newVendor('V-CLR-2');
    const bill = await apInvoices.postApInvoice({
      companyCodeId,
      partnerId: bp,
      postingDate: '2026-03-10',
      documentDate: '2026-03-10',
      currency: 'KRW',
      reference: 'BILL-CLR-2',
      lines: [{ expenseAccount: '5000', netAmount: '200000' }],
    });

    const result = await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: bill.journalId,
      postingDate: '2026-03-22',
      postingKey: 'itest:clr-ap-2',
    });
    expect(result).toMatchObject({ docType: 'KZ', side: 'AP', currency: 'KRW', realizedFx: null });

    const entry = await journals.getJournal(result.journalId);
    expect(entry).toMatchObject({ docType: 'KZ', docNo: 'KZ-2026-000001' });
    // AP payment: Dr payable / Cr cash.
    expect(lineOf(entry, '2100')).toMatchObject({ drCr: 'D', amount: '200000.0000', partnerId: bp });
    expect(lineOf(entry, '1010')).toMatchObject({ drCr: 'C', amount: '200000.0000' });
    expect(functionalNet(entry)).toBe(0);

    const open = await apInvoices.listOpenItems({ companyCodeId, partnerId: bp });
    expect(open.items).toHaveLength(0);
    expect(open.balance).toBeNull();
  });

  // 3
  it('same-currency full clear books no realized FX: two lines, functionalNet 0, no gain/loss line', async () => {
    const bp = await newCustomer('C-CLR-3');
    const invId = await arInvoiceKrw(bp, '50000', 'INV-CLR-3');
    const result = await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-03-20',
      postingKey: 'itest:clr-ar-3',
    });
    expect(result.realizedFx).toBeNull();
    const entry = await journals.getJournal(result.journalId);
    expect(entry.lines).toHaveLength(2);
    expect(lineOf(entry, '9810')).toBeUndefined();
    expect(lineOf(entry, '9820')).toBeUndefined();
    expect(entry.fxRate).toBeNull();
    expect(functionalNet(entry)).toBe(0);
  });

  // 4
  it('clears a foreign AR invoice at a HIGHER settlement rate and books the realized FX gain (9810)', async () => {
    const bp = await newCustomer('C-CLR-4');
    const invId = await arInvoiceUsd(bp, '1000', 'INV-CLR-4'); // USD 1000 @1300 → recon functional 1,300,000
    const result = await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-06-15', // settlement @1400
      postingKey: 'itest:clr-ar-4',
    });
    expect(result.realizedFx).toEqual({ account: '9810', kind: 'GAIN', amount: '100000.0000' });

    const entry = await journals.getJournal(result.journalId);
    expect(entry.lines).toHaveLength(3);
    expect(Number(entry.fxRate)).toBe(1400);
    // Cash at the settlement rate; receivable closed at its ORIGINAL invoice-date functional value.
    expect(lineOf(entry, '1010')).toMatchObject({
      drCr: 'D',
      amount: '1000.0000',
      currency: 'USD',
      functionalAmount: '1400000.0000',
    });
    expect(lineOf(entry, '1100')).toMatchObject({
      drCr: 'C',
      amount: '1000.0000',
      currency: 'USD',
      functionalAmount: '1300000.0000',
      partnerId: bp,
    });
    // Realized gain: 0 in the foreign document currency, the functional delta on the credit side.
    expect(lineOf(entry, '9810')).toMatchObject({
      drCr: 'C',
      amount: '0.0000',
      currency: 'USD',
      functionalAmount: '100000.0000',
      isReconAccount: false,
    });
    expect(functionalNet(entry)).toBe(0); // doc currency balances; functional ties out via the gain line

    const open = await arInvoices.listOpenItems({ companyCodeId, partnerId: bp });
    expect(open.items).toHaveLength(0);
  });

  // 5
  it('clears a foreign AR invoice at a LOWER settlement rate and books the realized FX loss (9820)', async () => {
    const bp = await newCustomer('C-CLR-5');
    const invId = await arInvoiceUsd(bp, '1000', 'INV-CLR-5'); // @1300 → 1,300,000
    const result = await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-09-20', // settlement @1200
      postingKey: 'itest:clr-ar-5',
    });
    expect(result.realizedFx).toEqual({ account: '9820', kind: 'LOSS', amount: '100000.0000' });

    const entry = await journals.getJournal(result.journalId);
    expect(lineOf(entry, '1010')).toMatchObject({ functionalAmount: '1200000.0000' });
    expect(lineOf(entry, '1100')).toMatchObject({ functionalAmount: '1300000.0000' });
    // Loss sits on the DEBIT side (the short side when cash functional < receivable functional).
    expect(lineOf(entry, '9820')).toMatchObject({
      drCr: 'D',
      amount: '0.0000',
      functionalAmount: '100000.0000',
    });
    expect(functionalNet(entry)).toBe(0);
  });

  // 6
  it('clears at the exact document-date rate: zero realized FX, no gain/loss line, both currencies balance', async () => {
    const bp = await newCustomer('C-CLR-6');
    const invId = await arInvoiceUsd(bp, '1000', 'INV-CLR-6'); // @1300
    const result = await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-03-05', // still @1300 (1400 starts Jun) → no realized FX
      postingKey: 'itest:clr-ar-6',
    });
    expect(result.realizedFx).toBeNull();
    const entry = await journals.getJournal(result.journalId);
    expect(entry.lines).toHaveLength(2);
    expect(lineOf(entry, '1010')).toMatchObject({ functionalAmount: '1300000.0000' });
    expect(lineOf(entry, '1100')).toMatchObject({ functionalAmount: '1300000.0000' });
    expect(functionalNet(entry)).toBe(0);
  });

  // 7
  it('resolves cash + realized-FX accounts via account_determination (no hard-coded account); a missing rule fails loudly', async () => {
    // Happy path already proven (1010/9810 above). Now prove the loud failure with NO silent fallback.
    await db
      .delete(schema.accountDetermination)
      .where(
        and(
          eq(schema.accountDetermination.chartOfAccounts, 'KR01'),
          eq(schema.accountDetermination.transactionKey, 'REALIZED_FX_GAIN'),
        ),
      );
    const bp = await newCustomer('C-CLR-7');
    const invId = await arInvoiceUsd(bp, '1000', 'INV-CLR-7');
    await expect(
      clearing.clear({
        companyCodeId,
        partnerId: bp,
        journalId: invId,
        postingDate: '2026-06-15', // @1400 → would need a REALIZED_FX_GAIN rule
        postingKey: 'itest:clr-ar-7',
      }),
    ).rejects.toThrow(/no account determination rule/);
    // Restore the rule for any later test.
    await accountDet.defineRule({
      chartOfAccounts: 'KR01',
      transactionKey: 'REALIZED_FX_GAIN',
      glAccount: '9810',
    });
  });

  // 8
  it('is idempotent on the clearing posting key: a replay returns the same clearing, once in the DB', async () => {
    const bp = await newCustomer('C-CLR-8');
    const invId = await arInvoiceKrw(bp, '70000', 'INV-CLR-8');
    const dto = {
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-03-20',
      postingKey: 'itest:clr-idem',
    };
    const first = await clearing.clear(dto);
    const replay = await clearing.clear(dto);
    expect(replay.journalId).toBe(first.journalId);
    expect(replay.replayed).toBe(true);

    const rows = await db
      .select()
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.postingKey, 'itest:clr-idem'));
    expect(rows).toHaveLength(1);
  });

  // 9
  it('resets a clearing via reverse(): AB mirror re-opens the item; a second reset is idempotent', async () => {
    const bp = await newCustomer('C-CLR-9');
    const invId = await arInvoiceKrw(bp, '100000', 'INV-CLR-9');
    const cleared = await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-03-20',
      postingKey: 'itest:clr-reset-9',
    });
    expect((await arInvoices.listOpenItems({ companyCodeId, partnerId: bp })).items).toHaveLength(0);

    const reset = await clearing.reset(cleared.journalId, { reason: 'cleared in error', postingDate: '2026-03-25' });
    const resetEntry = await journals.getJournal(reset.journalId);
    expect(resetEntry).toMatchObject({ docType: 'AB' }); // reset draws the JE range
    expect(lineOf(resetEntry, '1100')).toMatchObject({ drCr: 'D', amount: '100000.0000' }); // mirror of the clearing Cr
    expect(functionalNet(resetEntry)).toBe(0);

    // The clearing is now REVERSED → its CLEARS edge is non-live → the item re-opens (invoice + DZ + AB).
    const open = await arInvoices.listOpenItems({ companyCodeId, partnerId: bp });
    expect(open.items).toHaveLength(3);
    expect(open.balance).toEqual({ amount: '100000.0000', currency: 'KRW' });

    const reset2 = await clearing.reset(cleared.journalId, { reason: 'again' });
    expect(reset2.journalId).toBe(reset.journalId); // idempotent
  });

  // 10
  it('resets a foreign-currency clearing: the realized gain is reversed exactly, net zero in both currencies', async () => {
    const bp = await newCustomer('C-CLR-10');
    const invId = await arInvoiceUsd(bp, '1000', 'INV-CLR-10'); // @1300 → 1,300,000
    const cleared = await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-06-15', // @1400 → gain 100,000
      postingKey: 'itest:clr-reset-10',
    });
    const clearingEntry = await journals.getJournal(cleared.journalId);

    const reset = await clearing.reset(cleared.journalId, { reason: 'reset fx', postingDate: '2026-06-20' });
    const resetEntry = await journals.getJournal(reset.journalId);
    // Functional amounts copied VERBATIM (no re-translation at the reset-date rate): gain reversed exactly.
    expect(lineOf(resetEntry, '9810')).toMatchObject({ drCr: 'D', functionalAmount: '100000.0000' });
    expect(lineOf(resetEntry, '1010')).toMatchObject({ drCr: 'C', functionalAmount: '1400000.0000' });
    expect(lineOf(resetEntry, '1100')).toMatchObject({ drCr: 'D', functionalAmount: '1300000.0000' });
    expect(functionalNet(clearingEntry) + functionalNet(resetEntry)).toBe(0);
    expect(functionalNet(resetEntry)).toBe(0);

    const open = await arInvoices.listOpenItems({ companyCodeId, partnerId: bp });
    expect(open.items).toHaveLength(3);
    expect(open.balance).toEqual({ amount: '1000.0000', currency: 'USD' });
  });

  // 11
  it('cannot clear an already-cleared item: a second clear (different key) is rejected (Conflict)', async () => {
    const bp = await newCustomer('C-CLR-11');
    const invId = await arInvoiceKrw(bp, '30000', 'INV-CLR-11');
    await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-03-20',
      postingKey: 'itest:clr-11a',
    });
    await expect(
      clearing.clear({
        companyCodeId,
        partnerId: bp,
        journalId: invId,
        postingDate: '2026-03-21',
        postingKey: 'itest:clr-11b',
      }),
    ).rejects.toThrow(/already cleared/);
  });

  // 12
  it('rejects partial clearing: an amount that is not the open item gross is rejected (BadRequest)', async () => {
    const bp = await newCustomer('C-CLR-12');
    const invId = await arInvoiceKrw(bp, '100000', 'INV-CLR-12');
    await expect(
      clearing.clear({
        companyCodeId,
        partnerId: bp,
        journalId: invId,
        postingDate: '2026-03-20',
        amount: '40000', // ≠ gross 100000
        postingKey: 'itest:clr-12',
      }),
    ).rejects.toThrow(/partial clearing is out of scope/);
  });

  // 13
  it('after a foreign clear + reset round-trip, the affected accounts net to zero in the trial balance', async () => {
    const bp = await newCustomer('C-CLR-13');
    const invId = await arInvoiceUsd(bp, '1000', 'INV-CLR-13', '2026-07-10'); // @1400 → 1,400,000
    // Clear + reset both in period 11 — a period no other test posts to — so the trial balance for
    // that period isolates this round-trip (the cash + realized-FX movements must cancel to zero).
    const cleared = await clearing.clear({
      companyCodeId,
      partnerId: bp,
      journalId: invId,
      postingDate: '2026-11-20', // @1200 → loss 200,000
      postingKey: 'itest:clr-13',
    });
    await clearing.reset(cleared.journalId, { reason: 'round-trip', postingDate: '2026-11-25' });

    // The clearing + its reset cancel: the cash, recon-clearing, and realized-FX movements net to zero.
    const tb = await journals.trialBalance(companyCodeId, 2026, 11);
    for (const acc of ['1010', '9820']) {
      const row = tb.find((r) => r.glAccount === acc);
      expect(row?.balance).toBe('0.0000');
    }
  });
});
