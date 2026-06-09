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
import { GlAccountService } from '../../src/domains/master-data/gl-account/gl-account.service.js';
import { DbCurrencyRegistry } from '../../src/domains/master-data/currency/db-currency-registry.js';
import { CurrencyService } from '../../src/domains/master-data/currency/currency.service.js';
import { AccountDeterminationService } from '../../src/domains/platform/admin-config/account-determination.service.js';
import { JournalService } from '../../src/domains/finance-accounting/general-ledger/journal.service.js';
import {
  JOURNAL_EVENT_NAMESPACE,
  uuidV5,
} from '../../src/domains/finance-accounting/general-ledger/posting-id.js';

/**
 * FI general-ledger integration over a real PostgreSQL 16 (Testcontainers, root CLAUDE.md §5.4 —
 * FI postings get integration tests). Runs the committed migrations 0001..0008, then proves the
 * posting kernel end-to-end: balanced posting, the balance/immutability DB backstop triggers,
 * period locking, idempotency, reversal, the reconciliation-account rules, and the trial balance.
 * Set SKIP_TESTCONTAINERS=1 to skip where Docker is absent.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('finance-accounting general-ledger (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;
  let fiscal: FiscalPeriodService;
  let journals: JournalService;
  let companyCodeId: string;
  let fiscalYearId: string;
  let costCenterId: string;
  let partnerId: string;

  /** Two-line manual journal in KRW: Dr `dr` / Cr `cr` for `amount`. */
  const manual = (
    postingKey: string,
    postingDate: string,
    amount: string,
    dr = '1000',
    cr = '4000',
  ) => ({
    companyCodeId,
    postingDate,
    currency: 'KRW',
    reference: 'manual',
    postingKey,
    lines: [
      { glAccount: dr, drCr: 'D' as const, amount },
      { glAccount: cr, drCr: 'C' as const, amount },
    ],
  });

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
    journals = new JournalService(
      db,
      fiscal,
      numbering,
      new OutboxService(db),
      new DocFlowService(db),
      glAccounts,
      registry,
      new CurrencyService(db, registry),
      new AccountDeterminationService(db),
    );

    const company = await org.createCompanyCode({
      code: '1000',
      name: 'Heyday Trading',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    companyCodeId = company.id;
    fiscalYearId = await fiscal.generateYear(companyCodeId, 2026);

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

    await numbering.defineRange({
      object: 'finance.journal_entry',
      scope: '2026',
      prefix: 'JE-2026-',
      padding: 6,
    });

    for (const acc of [
      { accountNumber: '1000', name: '현금', accountType: 'ASSET' as const },
      {
        accountNumber: '1100',
        name: '외상매출금',
        accountType: 'ASSET' as const,
        isReconciliation: true,
      },
      { accountNumber: '4000', name: '제품매출', accountType: 'REVENUE' as const },
      { accountNumber: '6100', name: '지급수수료', accountType: 'EXPENSE' as const },
    ]) {
      await glAccounts.ensureGlAccount({
        chartOfAccounts: 'KR01',
        isReconciliation: false,
        ...acc,
      });
    }

    const [costCenter] = await db
      .insert(schema.costCenter)
      .values({
        code: 'CC10',
        name: 'Admin',
        companyCodeId,
        createdBy: 'system',
        updatedBy: 'system',
      })
      .returning({ id: schema.costCenter.id });
    costCenterId = costCenter!.id;

    const [bp] = await db
      .insert(schema.businessPartner)
      .values({
        code: 'C9000',
        name: 'Test Customer',
        bpType: 'ORGANIZATION',
        createdBy: 'system',
        updatedBy: 'system',
      })
      .returning({ id: schema.businessPartner.id });
    partnerId = bp!.id;
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  // 1
  it('posts a balanced manual entry: number, period stamp, lines, and the outbox event', async () => {
    const posted = await journals.postManual(manual('itest:balanced', '2026-03-15', '100000'));
    expect(posted.status).toBe('POSTED');

    const entry = await journals.getJournal(posted.journalId);
    expect(entry).toMatchObject({
      docType: 'SA',
      docNo: 'JE-2026-000001',
      status: 'POSTED',
      fiscalYear: 2026,
      periodNo: 3,
      currency: 'KRW',
      functionalCurrency: 'KRW',
      createdBy: 'system',
    });
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0]).toMatchObject({
      lineNo: 1,
      glAccount: '1000',
      drCr: 'D',
      amount: '100000.0000',
      functionalAmount: '100000.0000',
      isReconAccount: false,
    });
    expect(entry.lines[1]).toMatchObject({ lineNo: 2, glAccount: '4000', drCr: 'C' });

    // Same-transaction outbox row with the deterministic (UUIDv5, per-company) event id.
    const [event] = await db
      .select()
      .from(schema.outbox)
      .where(
        eq(
          schema.outbox.eventId,
          uuidV5(`${companyCodeId}:itest:balanced`, JOURNAL_EVENT_NAMESPACE),
        ),
      );
    expect(event).toMatchObject({ eventType: 'finance.journal.posted', status: 'PENDING' });
  });

  // 2
  it('rejects an unbalanced entry and writes nothing', async () => {
    const before = await journals.countJournals({ page: 1, pageSize: 1 });
    await expect(
      journals.postManual({
        ...manual('itest:unbalanced', '2026-03-15', '100000'),
        lines: [
          { glAccount: '1000', drCr: 'D', amount: '100000' },
          { glAccount: '4000', drCr: 'C', amount: '90000' },
        ],
      }),
    ).rejects.toThrow(/unbalanced/);
    expect(await journals.countJournals({ page: 1, pageSize: 1 })).toBe(before);
  });

  // 3
  it('rejects an entry with fewer than two lines', async () => {
    await expect(
      journals.postManual({
        ...manual('itest:one-line', '2026-03-15', '100000'),
        lines: [{ glAccount: '1000', drCr: 'D', amount: '100' }],
      }),
    ).rejects.toThrow(/at least two lines/);

    // …and an all-zero "entry" that moves no value is rejected even via the kernel input.
    await expect(
      journals.postManual({
        ...manual('itest:all-zero', '2026-03-15', '100000'),
        lines: [
          { glAccount: '1000', drCr: 'D', amount: '0' },
          { glAccount: '4000', drCr: 'C', amount: '0' },
        ],
      }),
    ).rejects.toThrow(/must move value/);
  });

  // 4
  it('enforces the period lock: closed period → Conflict, uncovered date → NotFound', async () => {
    const periods = await fiscal.listPeriods(fiscalYearId);
    const may = periods.find((p) => p.periodNo === 5)!;
    await fiscal.closePeriod(may.id);

    await expect(
      journals.postManual(manual('itest:closed-period', '2026-05-10', '1000')),
    ).rejects.toThrow(/closed/);
    await expect(
      journals.postManual(manual('itest:no-period', '2099-01-01', '1000')),
    ).rejects.toThrow(/no fiscal period/);
  });

  // 5
  it('is idempotent on the posting key: a replay returns the same entry, once in the DB', async () => {
    const first = await journals.postManual(manual('itest:idem', '2026-03-20', '5000'));
    const replay = await journals.postManual(manual('itest:idem', '2026-03-20', '5000'));
    expect(replay.journalId).toBe(first.journalId);

    const rows = await db
      .select()
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.postingKey, 'itest:idem'));
    expect(rows).toHaveLength(1);
  });

  // 6
  it('reverses into the current open period: mirror lines, lineage, doc-flow, net zero', async () => {
    const posted = await journals.postManual(manual('itest:reverse-me', '2026-04-10', '70000'));
    const reversal = await journals.reverse(
      posted.journalId,
      'posted in error',
      '2026-04-20',
      'system',
    );
    expect(reversal.postingKey).toBe('itest:reverse-me:REV');
    expect(reversal.status).toBe('POSTED');

    const original = await journals.getJournal(posted.journalId);
    const mirror = await journals.getJournal(reversal.journalId);
    expect(original.status).toBe('REVERSED');
    expect(original.reversedById).toBe(reversal.journalId);
    expect(mirror).toMatchObject({
      docType: 'AB',
      reversalOfId: posted.journalId,
      reversalReason: 'posted in error',
      periodNo: 4,
    });
    // Dr/Cr swapped, amounts (incl. functional) copied verbatim.
    expect(mirror.lines[0]).toMatchObject({
      glAccount: '1000',
      drCr: 'C',
      amount: '70000.0000',
      functionalAmount: '70000.0000',
    });
    expect(mirror.lines[1]).toMatchObject({ glAccount: '4000', drCr: 'D' });

    const [edge] = await db
      .select()
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceId, reversal.journalId),
          eq(schema.docFlow.relType, 'REVERSES'),
        ),
      );
    expect(edge).toMatchObject({ targetId: posted.journalId });

    // A replayed post() of the original key reports the LIVE state…
    const replay = await journals.post({
      postingKey: 'itest:reverse-me',
      companyCodeId,
      postingDate: '2026-04-10',
      currency: 'KRW',
      reference: 'manual',
      lines: [
        { glAccount: '1000', drCr: 'D', money: Money.of('70000', 'KRW') },
        { glAccount: '4000', drCr: 'C', money: Money.of('70000', 'KRW') },
      ],
    });
    expect(replay).toMatchObject({ journalId: posted.journalId, status: 'REVERSED' });
    // …and a second reverse() idempotently returns the existing reversal.
    const again = await journals.reverse(posted.journalId, 'retry', '2026-04-21');
    expect(again.journalId).toBe(reversal.journalId);

    // Original + reversal net to zero in the period.
    const tb = await journals.trialBalance(companyCodeId, 2026, 4);
    for (const row of tb) {
      expect(row.debit).toBe(row.credit);
      expect(row.balance).toBe('0.0000');
    }
  });

  // 7
  it('trial balance: Σdebit == Σcredit and per-account balances match hand-computed values', async () => {
    await journals.postManual(manual('itest:tb-1', '2026-06-05', '300000'));
    await journals.postManual(manual('itest:tb-2', '2026-06-10', '50000', '6100', '1000'));

    const tb = await journals.trialBalance(companyCodeId, 2026, 6);
    expect(tb).toEqual([
      {
        glAccount: '1000',
        currency: 'KRW',
        debit: '300000.0000',
        credit: '50000.0000',
        balance: '250000.0000',
      },
      {
        glAccount: '4000',
        currency: 'KRW',
        debit: '0.0000',
        credit: '300000.0000',
        balance: '-300000.0000',
      },
      {
        glAccount: '6100',
        currency: 'KRW',
        debit: '50000.0000',
        credit: '0.0000',
        balance: '50000.0000',
      },
    ]);

    const sum = (field: 'debit' | 'credit') =>
      tb.reduce((total, row) => total + Number(row[field]), 0);
    expect(sum('debit')).toBe(sum('credit'));
  });

  // 8
  it('blocks direct posting to a reconciliation account, but the subledger path stays open', async () => {
    await expect(
      journals.postManual(manual('itest:recon-direct', '2026-03-25', '1000', '1100')),
    ).rejects.toThrow(/reconciliation/);

    // The same account posts fine when the line carries its subledger partner (PR-B's path).
    const posted = await journals.post({
      postingKey: 'itest:recon-subledger',
      companyCodeId,
      postingDate: '2026-03-25',
      currency: 'KRW',
      reference: 'manual',
      lines: [
        { glAccount: '1100', drCr: 'D', money: Money.of('11000', 'KRW'), partnerId },
        { glAccount: '4000', drCr: 'C', money: Money.of('11000', 'KRW') },
      ],
    });
    const entry = await journals.getJournal(posted.journalId);
    expect(entry.lines[0]).toMatchObject({
      glAccount: '1100',
      isReconAccount: true,
      partnerId,
    });
  });

  // 9
  it('allows a cost center on P&L lines only', async () => {
    const posted = await journals.postManual({
      ...manual('itest:cc-ok', '2026-03-26', '2000'),
      lines: [
        { glAccount: '6100', drCr: 'D', amount: '2000', costCenterId },
        { glAccount: '1000', drCr: 'C', amount: '2000' },
      ],
    });
    const entry = await journals.getJournal(posted.journalId);
    expect(entry.lines[0]).toMatchObject({ glAccount: '6100', costCenterId });

    await expect(
      journals.postManual({
        ...manual('itest:cc-bad', '2026-03-26', '2000'),
        lines: [
          { glAccount: '1000', drCr: 'D', amount: '2000', costCenterId },
          { glAccount: '4000', drCr: 'C', amount: '2000' },
        ],
      }),
    ).rejects.toThrow(/P&L/);
  });

  // 10
  it('DB backstops: the deferred trigger rejects raw unbalanced writes; the fences reject edits', async () => {
    const periods = await fiscal.listPeriods(fiscalYearId);
    const july = periods.find((p) => p.periodNo === 7)!;
    const header = (docNo: string, postingKey: string) => ({
      docType: 'SA',
      docNo,
      status: 'POSTED',
      postingKey,
      companyCodeId,
      postingDate: '2026-07-10',
      documentDate: '2026-07-10',
      fiscalYear: 2026,
      periodNo: 7,
      fiscalPeriodId: july.id,
      currency: 'KRW',
      functionalCurrency: 'KRW',
      reference: 'raw',
      createdBy: 'system',
      updatedBy: 'system',
    });
    const line = (journalEntryId: string, lineNo: number, drCr: 'D' | 'C', amount: string) => ({
      journalEntryId,
      lineNo,
      glAccount: '1000',
      drCr,
      amount,
      currency: 'KRW',
      functionalAmount: amount,
      functionalCurrency: 'KRW',
      createdBy: 'system',
      updatedBy: 'system',
    });

    // Unbalanced raw insert → rejected at COMMIT by the deferred constraint trigger.
    await expect(
      db.transaction(async (tx) => {
        const [h] = await tx
          .insert(schema.journalEntry)
          .values(header('RAW-1', 'raw:unbalanced'))
          .returning({ id: schema.journalEntry.id });
        await tx
          .insert(schema.journalLine)
          .values([line(h!.id, 1, 'D', '100.0000'), line(h!.id, 2, 'C', '90.0000')]);
      }),
    ).rejects.toThrow(/unbalanced/);

    // Fewer than two lines → likewise rejected at COMMIT (a zero line is balanced, so the
    // line-count rule is what fires).
    await expect(
      db.transaction(async (tx) => {
        const [h] = await tx
          .insert(schema.journalEntry)
          .values(header('RAW-2', 'raw:one-line'))
          .returning({ id: schema.journalEntry.id });
        await tx.insert(schema.journalLine).values([line(h!.id, 1, 'D', '0.0000')]);
      }),
    ).rejects.toThrow(/at least two lines/);

    // Line currency must match the header's document currency, even when balanced.
    await expect(
      db.transaction(async (tx) => {
        const [h] = await tx
          .insert(schema.journalEntry)
          .values(header('RAW-3', 'raw:foreign-currency'))
          .returning({ id: schema.journalEntry.id });
        await tx.insert(schema.journalLine).values([
          { ...line(h!.id, 1, 'D', '10.0000'), currency: 'USD' },
          { ...line(h!.id, 2, 'C', '10.0000'), currency: 'USD' },
        ]);
      }),
    ).rejects.toThrow(/outside its document currency/);

    // Immutability fences: posted rows reject UPDATE and DELETE outright.
    const posted = await journals.postManual(manual('itest:fence', '2026-07-15', '3000'));
    await expect(
      db
        .update(schema.journalEntry)
        .set({ reference: 'tampered' })
        .where(eq(schema.journalEntry.id, posted.journalId)),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.delete(schema.journalEntry).where(eq(schema.journalEntry.id, posted.journalId)),
    ).rejects.toThrow(/immutable/);
    await expect(
      db
        .update(schema.journalLine)
        .set({ amount: '1.0000' })
        .where(eq(schema.journalLine.journalEntryId, posted.journalId)),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.delete(schema.journalLine).where(eq(schema.journalLine.journalEntryId, posted.journalId)),
    ).rejects.toThrow(/immutable/);

    // Append-proof: even a BALANCED pair of extra lines cannot be added to a posted journal
    // (lines may only be inserted in the same transaction that created their header).
    await expect(
      db
        .insert(schema.journalLine)
        .values([
          line(posted.journalId, 3, 'D', '500.0000'),
          line(posted.journalId, 4, 'C', '500.0000'),
        ]),
    ).rejects.toThrow(/cannot be appended/);
  });
});
