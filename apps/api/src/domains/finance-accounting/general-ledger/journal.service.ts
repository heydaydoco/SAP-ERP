import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import {
  assertBalanced,
  assertFunctionalBalanced,
  Money,
  type FiPostingService,
  type JournalEntryInput,
  type PostedJournalEntry,
  type PostingLine,
} from '@erp/kernel';
import { DB } from '../../../database/database.module.js';
import { AccountDeterminationService } from '../../platform/admin-config/account-determination.service.js';
import { FiscalPeriodService } from '../../platform/admin-config/fiscal-period.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { OutboxService } from '../../platform/outbox/outbox.service.js';
import { CurrencyService } from '../../master-data/currency/currency.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import { GlAccountService } from '../../master-data/gl-account/gl-account.service.js';
import { JOURNAL_EVENT_NAMESPACE, uuidV5 } from './posting-id.js';
import { trialBalance, type TrialBalanceRow } from './trial-balance.js';
import type { CreateManualJournalDto, JournalQuery } from './journal.dto.js';

/** Document types (SAP BLART essence): manual GL entry / reversal / AR (customer) / AP (vendor). */
export const DOC_TYPE_MANUAL = 'SA';
export const DOC_TYPE_REVERSAL = 'AB';
/** Customer (AR) invoice ≈ SAP FB70; vendor (AP) invoice ≈ FB60 — both post through `post()`. */
export const DOC_TYPE_AR_INVOICE = 'DR';
export const DOC_TYPE_AP_INVOICE = 'KR';

/** Number-range objects — per-fiscal-year scope, seeded as e.g. (object, '2026', 'JE-2026-'). */
const NUMBER_OBJECT = 'finance.journal_entry';
const NUMBER_OBJECT_AR_INVOICE = 'finance.ar_invoice';
const NUMBER_OBJECT_AP_INVOICE = 'finance.ap_invoice';

/**
 * Pick the document number range for a doc type. AR/AP invoices draw from their own DR-/KR- ranges
 * (a posted document type owns its number range, SAP-style); everything else — manual SA and the AB
 * reversals (`reverse()` is intentionally left on the JE range) — uses the general journal range.
 */
function numberObjectFor(docType: string): string {
  if (docType === DOC_TYPE_AR_INVOICE) return NUMBER_OBJECT_AR_INVOICE;
  if (docType === DOC_TYPE_AP_INVOICE) return NUMBER_OBJECT_AP_INVOICE;
  return NUMBER_OBJECT;
}
/** doc_flow node type for journal documents. */
const DOC_FLOW_TYPE = 'finance.journal_entry';

/**
 * account_determination transaction key for the FX per-line rounding plug (SAP KDR — a technical
 * rounding difference, NOT economic FX gain/loss). Its GL account MUST be `currency = null` so the
 * 0-amount line in the foreign document currency is not rejected against a currency-pinned account.
 */
const FX_ROUNDING_KEY = 'FX_ROUNDING';

/** True iff `e` is the Postgres unique violation for the named constraint. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint_name?: unknown };
  return err.code === '23505' && err.constraint_name === constraint;
}

interface ResolvedLine extends PostingLine {
  isReconAccount: boolean;
}

/** A resolved line paired with its functional-currency amount (the FX translation of `money`). */
interface TranslatedLine {
  line: ResolvedLine;
  functionalMoney: Money;
}

/**
 * Concrete fi-posting service (root CLAUDE.md §3.2) — the kernel stub made real. The SINGLE writer
 * of journal_entry/journal_line: every value-moving transaction calls `post()`; corrections go
 * through `reverse()` (§5.1 immutability). Enforcement is layered — the kernel `assertBalanced`
 * here is authoritative, row-local CHECKs and the 0008 deferred balance trigger + immutability
 * fences back it at the DB against any other writer.
 *
 * Cross-currency aware: when the document currency differs from the company's functional currency,
 * `post()` translates each line on the DOCUMENT date, injects an FX_ROUNDING line for the functional
 * tie-out, and stamps the rate on the header (see `translateLines`). A functional-currency entry is
 * byte-identical to the pre-FX path (rate NULL, functional_amount == amount). `reverse()` copies
 * functional amounts verbatim, so a reversal stays exact in both currencies without re-translating.
 */
@Injectable()
export class JournalService implements FiPostingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly fiscal: FiscalPeriodService,
    private readonly numbering: NumberingService,
    private readonly outbox: OutboxService,
    private readonly docFlow: DocFlowService,
    private readonly glAccounts: GlAccountService,
    private readonly registry: DbCurrencyRegistry,
    private readonly currencies: CurrencyService,
    private readonly accountDetermination: AccountDeterminationService,
  ) {}

  // ── kernel contract ─────────────────────────────────────────────────────────

  /**
   * Post a balanced entry; idempotent on `postingKey` (§5.2) — a replay returns the live state.
   * Keys are scoped per company code (composite UNIQUE), so one tenant can neither read nor
   * hijack another's entry by supplying its key.
   */
  async post(input: JournalEntryInput, actor = 'system'): Promise<PostedJournalEntry> {
    const existing = await this.findByPostingKey(input.companyCodeId, input.postingKey);
    if (existing) return this.toPosted(existing);

    const company = await this.getCompany(input.companyCodeId);

    // FX: the document currency may differ from the company's functional currency. The rate override
    // is FX-only — rejecting it on a functional-currency entry keeps the KRW==KRW path unambiguous.
    const isFx = input.currency !== company.currency;
    if (input.fxRate !== undefined && !isFx) {
      throw new BadRequestException(
        `fx rate override is only valid on a foreign-currency document; ${input.currency} is the ` +
          `functional currency`,
      );
    }
    for (const line of input.lines) {
      if (line.money.currency !== input.currency) {
        throw new BadRequestException(
          `line currency ${line.money.currency} differs from document currency ${input.currency}`,
        );
      }
      if (line.money.sign < 0) {
        throw new BadRequestException('line amounts are non-negative; the sign lives in drCr');
      }
    }

    if (input.lines.every((line) => line.money.isZero())) {
      throw new BadRequestException('a journal entry must move value — all lines are zero');
    }

    // Authoritative balance rule (kernel): ≥2 lines, debits == credits per DOCUMENT currency.
    try {
      assertBalanced(input.lines);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    // Period lock (§5.1) + the year/period stamp for the header.
    const period = await this.fiscal.resolveOpenPeriod(input.companyCodeId, input.postingDate);

    const resolved = await this.resolveLines(
      input.lines,
      company.chartOfAccounts,
      input.companyCodeId,
    );

    // Translate each line into the functional currency, plugging an FX entry's per-line rounding
    // residue with one FX_ROUNDING line so it ties out in the functional currency too. Translation
    // is keyed on the DOCUMENT date (SAP WWERT/BLDAT); KRW==KRW stays byte-identical (rate NULL,
    // functional_amount == amount). `lines` now carries each line's functional amount.
    const documentDate = input.documentDate ?? input.postingDate;
    const { fxRate, lines } = await this.translateLines(
      resolved,
      input.currency,
      company,
      isFx,
      input.fxRate,
      documentDate,
    );

    const docType = input.docType ?? DOC_TYPE_MANUAL;
    let journalId: string;
    try {
      journalId = await this.db.transaction(async (tx) => {
        // Inside the tx so a rollback never burns a gap-free number. AR/AP docs use their own range.
        const no = await this.numbering.next(
          numberObjectFor(docType),
          String(period.fiscalYear),
          tx,
        );
        const [header] = await tx
          .insert(schema.journalEntry)
          .values({
            docType,
            docNo: no,
            status: 'POSTED',
            postingKey: input.postingKey,
            companyCodeId: input.companyCodeId,
            postingDate: input.postingDate,
            documentDate: input.documentDate ?? input.postingDate,
            fiscalYear: period.fiscalYear,
            periodNo: period.periodNo,
            fiscalPeriodId: period.fiscalPeriodId,
            currency: input.currency,
            functionalCurrency: company.currency,
            // Doc→functional rate snapshot; NULL for a functional-currency (KRW==KRW) entry.
            fxRate,
            reference: input.reference,
            headerText: input.headerText ?? null,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning({ id: schema.journalEntry.id });
        if (!header) throw new Error('journal_entry insert returned no row');

        await tx.insert(schema.journalLine).values(
          lines.map(({ line, functionalMoney }, i) => ({
            journalEntryId: header.id,
            lineNo: i + 1,
            glAccount: line.glAccount,
            drCr: line.drCr,
            amount: line.money.toNumeric(),
            currency: line.money.currency,
            // The line translated into the functional currency (== amount when doc == functional).
            functionalAmount: functionalMoney.toNumeric(),
            functionalCurrency: company.currency,
            isReconAccount: line.isReconAccount,
            partnerId: line.partnerId ?? null,
            costCenterId: line.costCenterId ?? null,
            taxCode: line.taxCode ?? null,
            lineText: line.lineText ?? null,
            createdBy: actor,
            updatedBy: actor,
          })),
        );

        // Same tx (§5.2): the event exists iff the journal does. Deterministic id = retry-safe.
        await this.outbox.enqueue(
          {
            eventType: 'finance.journal.posted',
            eventId: this.eventId(input.companyCodeId, input.postingKey),
            payload: {
              journalId: header.id,
              docType,
              docNo: no,
              postingKey: input.postingKey,
              companyCodeId: input.companyCodeId,
              fiscalYear: period.fiscalYear,
              periodNo: period.periodNo,
              currency: input.currency,
              reference: input.reference,
              lineCount: lines.length,
            },
          },
          tx,
        );

        return header.id;
      });
    } catch (e) {
      // Concurrent duplicate post: the UNIQUE(company, posting_key) gate fired — replay the winner.
      if (isUniqueViolation(e, 'journal_entry_posting_key_uq')) {
        const winner = await this.findByPostingKey(input.companyCodeId, input.postingKey);
        if (winner) return this.toPosted(winner);
      }
      throw e;
    }

    return { journalId, postingKey: input.postingKey, status: 'POSTED' };
  }

  /**
   * Correct a posted entry by generating its reversal (§5.1 — the original is never edited beyond
   * the fenced POSTED→REVERSED back-pointer flip). The reversal posts into the CURRENT open period
   * (`postingDate`, default today) and passes the same period lock as any posting; a closed
   * original period stays closed. Lines are mirrored with Dr/Cr swapped and functional amounts
   * copied VERBATIM — a reversal never re-translates FX, so original + reversal net to exactly
   * zero in both currencies. Idempotent: the reversal's posting key is `<original>:REV`, and
   * reversing an already-reversed entry returns the existing reversal.
   */
  async reverse(
    journalId: string,
    reason: string,
    postingDate?: string,
    actor = 'system',
  ): Promise<PostedJournalEntry> {
    const [original] = await this.db
      .select()
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.id, journalId));
    if (!original) throw new NotFoundException(`journal entry ${journalId} not found`);

    if (original.status === 'REVERSED') {
      if (!original.reversedById) {
        throw new ConflictException(`journal ${journalId} is REVERSED but has no reversal pointer`);
      }
      const [reversal] = await this.db
        .select()
        .from(schema.journalEntry)
        .where(eq(schema.journalEntry.id, original.reversedById));
      if (!reversal) throw new ConflictException(`reversal of journal ${journalId} not found`);
      return this.toPosted(reversal);
    }

    const reversalKey = `${original.postingKey}:REV`;
    if (reversalKey.length > 128) {
      throw new BadRequestException('posting key too long to derive a reversal key');
    }

    const reversalDate = postingDate ?? new Date().toISOString().slice(0, 10);
    // The reversal is a posting like any other: it must land in an OPEN period (§5.1).
    const period = await this.fiscal.resolveOpenPeriod(original.companyCodeId, reversalDate);

    const originalLines = await this.db
      .select()
      .from(schema.journalLine)
      .where(eq(schema.journalLine.journalEntryId, journalId))
      .orderBy(asc(schema.journalLine.lineNo));
    if (originalLines.length < 2) {
      // Unreachable for anything posted through this service / past the 0008 trigger — assert
      // locally anyway rather than lean on the upstream guarantee.
      throw new ConflictException(`journal ${journalId} has fewer than two lines`);
    }

    let reversalId: string;
    try {
      reversalId = await this.db.transaction(async (tx) => {
        const docNo = await this.numbering.next(NUMBER_OBJECT, String(period.fiscalYear), tx);
        const [header] = await tx
          .insert(schema.journalEntry)
          .values({
            docType: DOC_TYPE_REVERSAL,
            docNo,
            status: 'POSTED',
            postingKey: reversalKey,
            companyCodeId: original.companyCodeId,
            postingDate: reversalDate,
            documentDate: reversalDate,
            fiscalYear: period.fiscalYear,
            periodNo: period.periodNo,
            fiscalPeriodId: period.fiscalPeriodId,
            currency: original.currency,
            functionalCurrency: original.functionalCurrency,
            fxRate: original.fxRate,
            reference: original.reference,
            headerText: original.headerText,
            reversalOfId: original.id,
            reversalReason: reason,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning({ id: schema.journalEntry.id });
        if (!header) throw new Error('journal_entry insert returned no row');

        await tx.insert(schema.journalLine).values(
          originalLines.map((line) => ({
            journalEntryId: header.id,
            lineNo: line.lineNo,
            glAccount: line.glAccount,
            drCr: line.drCr === 'D' ? ('C' as const) : ('D' as const),
            amount: line.amount,
            currency: line.currency,
            // Verbatim copy — NEVER re-translate a reversal (see method doc).
            functionalAmount: line.functionalAmount,
            functionalCurrency: line.functionalCurrency,
            isReconAccount: line.isReconAccount,
            partnerId: line.partnerId,
            costCenterId: line.costCenterId,
            taxCode: line.taxCode,
            lineText: line.lineText,
            createdBy: actor,
            updatedBy: actor,
          })),
        );

        // The one fenced UPDATE (0008 trigger): POSTED → REVERSED + back-pointer.
        await tx
          .update(schema.journalEntry)
          .set({
            status: 'REVERSED',
            reversedById: header.id,
            updatedAt: new Date(),
            updatedBy: actor,
          })
          .where(eq(schema.journalEntry.id, original.id));

        await this.docFlow.link(
          {
            sourceType: DOC_FLOW_TYPE,
            sourceId: header.id,
            targetType: DOC_FLOW_TYPE,
            targetId: original.id,
            relType: 'REVERSES',
          },
          tx,
        );

        await this.outbox.enqueue(
          {
            eventType: 'finance.journal.reversed',
            eventId: this.eventId(original.companyCodeId, reversalKey),
            payload: {
              journalId: header.id,
              docNo,
              postingKey: reversalKey,
              reversalOfId: original.id,
              companyCodeId: original.companyCodeId,
              fiscalYear: period.fiscalYear,
              periodNo: period.periodNo,
              reason,
            },
          },
          tx,
        );

        return header.id;
      });
    } catch (e) {
      // Concurrent double-reverse: the UNIQUE gate on '<original>:REV' serializes the race.
      if (isUniqueViolation(e, 'journal_entry_posting_key_uq')) {
        const winner = await this.findByPostingKey(original.companyCodeId, reversalKey);
        if (winner) return this.toPosted(winner);
      }
      throw e;
    }

    return { journalId: reversalId, postingKey: reversalKey, status: 'POSTED' };
  }

  // ── domain-facing API ───────────────────────────────────────────────────────

  /** Manual GL entry from the REST DTO — mints an idempotency key when the client sent none. */
  async postManual(dto: CreateManualJournalDto, actor = 'system'): Promise<PostedJournalEntry> {
    let lines: PostingLine[];
    try {
      lines = dto.lines.map((line) => ({
        glAccount: line.glAccount,
        drCr: line.drCr,
        // Strict parse: rejects finer precision than the currency allows (e.g. '100.5' KRW).
        money: Money.fromNumeric(line.amount, dto.currency, this.registry),
        costCenterId: line.costCenterId,
        lineText: line.lineText,
      }));
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    return this.post(
      {
        postingKey: dto.postingKey ?? `manual:${randomUUID()}`,
        companyCodeId: dto.companyCodeId,
        postingDate: dto.postingDate,
        documentDate: dto.documentDate,
        docType: DOC_TYPE_MANUAL,
        currency: dto.currency,
        // Optional manual FX-rate override; post() rejects it on a functional-currency entry.
        fxRate: dto.fxRate,
        reference: dto.reference,
        headerText: dto.headerText,
        lines,
      },
      actor,
    );
  }

  /** Header + lines, or 404. */
  async getJournal(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.id, id));
    if (!header) throw new NotFoundException(`journal entry ${id} not found`);
    const lines = await this.db
      .select()
      .from(schema.journalLine)
      .where(eq(schema.journalLine.journalEntryId, id))
      .orderBy(asc(schema.journalLine.lineNo));
    return { ...header, lines };
  }

  async listJournals(q: JournalQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.journalEntry)
      .where(this.listWhere(q))
      .orderBy(asc(schema.journalEntry.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countJournals(q: JournalQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.journalEntry)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  /**
   * Per-(account, currency) debit/credit totals for a period (or whole year). Includes reversed
   * originals AND their reversals — both are real GL rows, so a reversed pair nets to zero.
   */
  async trialBalance(
    companyCodeId: string,
    fiscalYear: number,
    periodNo?: number,
  ): Promise<TrialBalanceRow[]> {
    const rows = await this.db
      .select({
        glAccount: schema.journalLine.glAccount,
        currency: schema.journalLine.currency,
        drCr: schema.journalLine.drCr,
        amount: schema.journalLine.amount,
      })
      .from(schema.journalLine)
      .innerJoin(schema.journalEntry, eq(schema.journalLine.journalEntryId, schema.journalEntry.id))
      .where(
        and(
          eq(schema.journalEntry.companyCodeId, companyCodeId),
          eq(schema.journalEntry.fiscalYear, fiscalYear),
          periodNo === undefined ? undefined : eq(schema.journalEntry.periodNo, periodNo),
        ),
      );
    return trialBalance(rows);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: JournalQuery) {
    return and(
      q.companyCodeId ? eq(schema.journalEntry.companyCodeId, q.companyCodeId) : undefined,
      q.fiscalYear === undefined ? undefined : eq(schema.journalEntry.fiscalYear, q.fiscalYear),
      q.periodNo === undefined ? undefined : eq(schema.journalEntry.periodNo, q.periodNo),
    );
  }

  private async getCompany(companyCodeId: string) {
    const [company] = await this.db
      .select()
      .from(schema.companyCode)
      .where(eq(schema.companyCode.id, companyCodeId));
    if (!company) throw new NotFoundException(`company code ${companyCodeId} not found`);
    if (!company.chartOfAccounts) {
      throw new ConflictException(`company code ${company.code} has no chart of accounts assigned`);
    }
    return { ...company, chartOfAccounts: company.chartOfAccounts };
  }

  /**
   * Validate each line against the masters (§4.5 — accounts must exist in the chart; never
   * hard-coded). Reconciliation accounts are subledger-only: a line hitting one MUST carry its
   * partner (PR-B's AR/AP path) — direct/manual GL lines may not (the app-layer block; the 0008
   * CHECK backs it at the DB). Cost centers ride P&L lines only. `normalBalance` is deliberately
   * NOT a gate — crediting an asset is how it decreases (see @erp/shared accounting.ts).
   */
  private async resolveLines(
    lines: readonly PostingLine[],
    chartOfAccounts: string,
    companyCodeId: string,
  ): Promise<ResolvedLine[]> {
    const resolved: ResolvedLine[] = [];
    for (const line of lines) {
      const account = await this.glAccounts.getByNumber(chartOfAccounts, line.glAccount);
      if (account.currency && account.currency !== line.money.currency) {
        throw new BadRequestException(
          `gl account ${line.glAccount} is fixed to ${account.currency} and cannot take a ` +
            `${line.money.currency} line`,
        );
      }
      if (account.isReconciliation && !line.partnerId) {
        throw new BadRequestException(
          `gl account ${line.glAccount} is a reconciliation account — it is posted through its ` +
            `subledger (with a partner), never directly`,
        );
      }
      if (line.costCenterId) {
        if (account.accountType !== 'REVENUE' && account.accountType !== 'EXPENSE') {
          throw new BadRequestException(
            `cost center is only allowed on P&L lines; ${line.glAccount} is ${account.accountType}`,
          );
        }
        const [costCenter] = await this.db
          .select({ companyCodeId: schema.costCenter.companyCodeId })
          .from(schema.costCenter)
          .where(eq(schema.costCenter.id, line.costCenterId));
        if (!costCenter) throw new NotFoundException(`cost center ${line.costCenterId} not found`);
        if (costCenter.companyCodeId !== companyCodeId) {
          throw new BadRequestException(
            `cost center ${line.costCenterId} belongs to another company code`,
          );
        }
      }
      resolved.push({ ...line, isReconAccount: account.isReconciliation });
    }
    return resolved;
  }

  /**
   * Compute each line's functional-currency amount. A functional-currency entry is the identity
   * (functional == document, rate NULL) so the KRW==KRW path stays byte-identical to the pre-FX
   * slice. An FX entry resolves the document→functional rate (explicit override, else the 'M' master
   * rate on the document date — NEVER a reciprocal of a stored rate), translates each line half-away
   * to the functional minor unit, and injects ONE FX_ROUNDING line carrying the residue so
   * Σdebit == Σcredit in the functional currency. `assertFunctionalBalanced` proves the tie-out
   * before the write; the 0009 DB trigger re-checks it at COMMIT (and on every reversal).
   */
  private async translateLines(
    resolved: ResolvedLine[],
    documentCurrency: string,
    company: { id: string; code: string; currency: string; chartOfAccounts: string },
    isFx: boolean,
    override: string | undefined,
    documentDate: string,
  ): Promise<{ fxRate: string | null; lines: TranslatedLine[] }> {
    if (!isFx) {
      return {
        fxRate: null,
        lines: resolved.map((line) => ({ line, functionalMoney: line.money })),
      };
    }

    const functionalCurrency = company.currency;
    const rate =
      override ?? (await this.resolveDocRate(documentCurrency, functionalCurrency, documentDate));

    let translated: TranslatedLine[];
    try {
      translated = resolved.map((line) => ({
        line,
        functionalMoney: line.money.convert(rate, functionalCurrency, this.registry),
      }));
    } catch (e) {
      // A malformed/over-precise override rate surfaces here as a client error.
      throw new BadRequestException((e as Error).message);
    }

    // Per-line rounding leaves a functional residue: Σ functional debit − Σ functional credit.
    const sideMinor = (drCr: 'D' | 'C'): bigint =>
      translated
        .filter((t) => t.line.drCr === drCr)
        .reduce((sum, t) => sum + t.functionalMoney.minorUnits, 0n);
    const residue = sideMinor('D') - sideMinor('C');
    if (residue !== 0n) {
      // KDR rounding plug: 0 in the document currency, the residue in the functional currency, on the
      // short side. account_determination supplies the GL account (must be currency=null, see above).
      const roundingAccount = await this.accountDetermination.resolve({
        transactionKey: FX_ROUNDING_KEY,
        chartOfAccounts: company.chartOfAccounts,
        companyCode: company.code,
      });
      const [roundLine] = await this.resolveLines(
        [
          {
            glAccount: roundingAccount,
            drCr: residue > 0n ? 'C' : 'D',
            money: Money.zero(documentCurrency, this.registry),
          },
        ],
        company.chartOfAccounts,
        company.id,
      );
      if (!roundLine) throw new Error('fx rounding line failed to resolve');
      translated.push({
        line: roundLine,
        functionalMoney: Money.fromMinorUnits(
          residue > 0n ? residue : -residue,
          functionalCurrency,
          this.registry,
        ),
      });
    }

    // Tie-out in the functional currency (service assert; the 0009 trigger is the DB backstop).
    try {
      assertFunctionalBalanced(
        translated.map((t) => ({ drCr: t.line.drCr, functionalAmount: t.functionalMoney })),
      );
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    return { fxRate: rate, lines: translated };
  }

  /** Resolve the document→functional 'M' rate effective on the document date (never reciprocated). */
  private async resolveDocRate(from: string, to: string, onDate: string): Promise<string> {
    const resolved = await this.currencies.resolveRate(from, to, onDate, 'M');
    return resolved.rate;
  }

  /** Outbox event id: deterministic per (company, posting key) so retries dedupe, tenants don't. */
  private eventId(companyCodeId: string, postingKey: string): string {
    return uuidV5(`${companyCodeId}:${postingKey}`, JOURNAL_EVENT_NAMESPACE);
  }

  private async findByPostingKey(companyCodeId: string, postingKey: string) {
    const [row] = await this.db
      .select()
      .from(schema.journalEntry)
      .where(
        and(
          eq(schema.journalEntry.companyCodeId, companyCodeId),
          eq(schema.journalEntry.postingKey, postingKey),
        ),
      );
    return row;
  }

  private toPosted(row: { id: string; postingKey: string; status: string }): PostedJournalEntry {
    if (row.status !== 'POSTED' && row.status !== 'REVERSED') {
      throw new Error(`unexpected journal status "${row.status}"`);
    }
    return { journalId: row.id, postingKey: row.postingKey, status: row.status };
  }
}
