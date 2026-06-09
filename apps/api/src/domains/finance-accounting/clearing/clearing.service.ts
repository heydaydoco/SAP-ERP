import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { Money, type PostedJournalEntry, type PostingLine } from '@erp/kernel';
import { DB } from '../../../database/database.module.js';
import { AccountDeterminationService } from '../../platform/admin-config/account-determination.service.js';
import { CurrencyService } from '../../master-data/currency/currency.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import { GlAccountService } from '../../master-data/gl-account/gl-account.service.js';
import {
  DOC_FLOW_TYPE,
  DOC_TYPE_AP_CLEARING,
  DOC_TYPE_AP_INVOICE,
  DOC_TYPE_AR_CLEARING,
  DOC_TYPE_AR_INVOICE,
  JournalService,
} from '../general-ledger/journal.service.js';
import type { CreateClearingDto, ResetClearingDto } from './clearing.dto.js';

/**
 * account_determination transaction keys the clearing slice resolves (never hard-coded, §4.5):
 * the cash/bank clearing account the payment hits, and the REALIZED FX gain/loss accounts. The
 * realized-FX accounts are economic P&L (외환차익/외환차손) — distinct from the FX_ROUNDING (SAP KDR)
 * technical sub-unit plug — and, like that plug, post a 0-amount foreign line, so their GL accounts
 * MUST be `currency = null` to pass the currency-pin check.
 */
const BANK_CLEARING_KEY = 'BANK_CLEARING';
const REALIZED_FX_GAIN_KEY = 'REALIZED_FX_GAIN';
const REALIZED_FX_LOSS_KEY = 'REALIZED_FX_LOSS';

/** doc_flow relationship: a clearing document settles (clears) an open invoice document. */
const REL_CLEARS = 'CLEARS';

export interface ClearingResult {
  journalId: string;
  postingKey: string;
  status: 'POSTED' | 'REVERSED';
  /** The invoice document this clearing settled. */
  clearedJournalId: string;
  /** True when an identical posting key already cleared this item (idempotent replay). */
  replayed?: boolean;
  side?: 'AR' | 'AP';
  docType?: string;
  reconAccount?: string;
  bankAccount?: string;
  /** Gross cleared (document currency). */
  amount?: string;
  currency?: string;
  /** Realized FX recognized (functional currency magnitude), or null for same-currency / zero-delta. */
  realizedFx?: { account: string; kind: 'GAIN' | 'LOSS'; amount: string } | null;
}

/**
 * Payment / clearing (finance-accounting.clearing). v1 = MANUAL, FULL clearing of one designated open
 * item, recognizing REALIZED FX on foreign items. It posts a NEW journal through the SAME
 * `JournalService.post()` (the only writer; D4 — no second store): it moves the open item's gross
 * against the cash/clearing account and, for a foreign item, books the rate movement between the
 * invoice date and the settlement date to a realized FX gain/loss account.
 *
 *   AR (DZ, customer receipt):  Dr cash (settlement rate) / Cr AR recon (ORIGINAL invoice rate, +partner)
 *   AP (KZ, vendor payment):    Dr AP recon (ORIGINAL invoice rate, +partner) / Cr cash (settlement rate)
 *   + Cr/Dr realized FX gain/loss (functional residue; 0 in the document currency)
 *
 * "Open" stays DERIVED (D4): the clearing links a `CLEARS` doc_flow edge to the invoice; an open item
 * is a recon line not participating in a LIVE clearing (its clearing not reversed) — there is no
 * clearing flag mutated onto the immutable recon line. Reset-clearing is `reverse()` of the clearing
 * document, which makes the edge non-live so the item re-opens automatically. Partial clearing,
 * payment runs, and bank-master/bank-reconciliation are out of v1 scope.
 */
@Injectable()
export class ClearingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly journals: JournalService,
    private readonly accountDetermination: AccountDeterminationService,
    private readonly currencies: CurrencyService,
    private readonly registry: DbCurrencyRegistry,
    private readonly glAccounts: GlAccountService,
  ) {}

  /** Clear one designated open AR/AP invoice in full; idempotent on the clearing posting key (§5.2). */
  async clear(dto: CreateClearingDto, actor = 'system'): Promise<ClearingResult> {
    const [invoice] = await this.db
      .select()
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.id, dto.journalId));
    if (!invoice) throw new NotFoundException(`journal entry ${dto.journalId} not found`);
    if (invoice.companyCodeId !== dto.companyCodeId) {
      throw new BadRequestException(`journal ${dto.journalId} belongs to another company code`);
    }
    if (invoice.status !== 'POSTED') {
      throw new ConflictException(`journal ${dto.journalId} is ${invoice.status}; cannot clear it`);
    }
    if (invoice.docType !== DOC_TYPE_AR_INVOICE && invoice.docType !== DOC_TYPE_AP_INVOICE) {
      throw new BadRequestException(
        `only AR (${DOC_TYPE_AR_INVOICE}) / AP (${DOC_TYPE_AP_INVOICE}) invoices can be cleared`,
      );
    }
    const side: 'AR' | 'AP' = invoice.docType === DOC_TYPE_AR_INVOICE ? 'AR' : 'AP';

    const company = await this.getCompany(dto.companyCodeId);

    // The single open recon line for this partner on the invoice (AR/AP invoices post exactly one).
    const reconLines = await this.db
      .select()
      .from(schema.journalLine)
      .where(
        and(
          eq(schema.journalLine.journalEntryId, dto.journalId),
          eq(schema.journalLine.isReconAccount, true),
          eq(schema.journalLine.partnerId, dto.partnerId),
        ),
      );
    if (reconLines.length === 0) {
      throw new BadRequestException(
        `journal ${dto.journalId} has no open recon line for partner ${dto.partnerId}`,
      );
    }
    if (reconLines.length > 1) {
      throw new BadRequestException(`journal ${dto.journalId} has more than one recon line`);
    }
    const recon = reconLines[0]!;
    const reconAccount = recon.glAccount;
    const docCurrency = recon.currency;
    const functionalCurrency = company.currency;
    const isFx = docCurrency !== functionalCurrency;

    // Idempotency + double-clear protection (§5.2 / §5.1). A replay of the SAME key returns the
    // existing clearing; a key whose clearing was RESET demands a fresh key; an item already settled
    // by a different LIVE clearing is a conflict.
    const computedKey = dto.postingKey ?? `clr:${dto.journalId}`;
    const prior = await this.findEntryByKey(dto.companyCodeId, computedKey);
    if (prior) {
      if (prior.status === 'POSTED') {
        return {
          journalId: prior.id,
          postingKey: prior.postingKey,
          status: 'POSTED',
          clearedJournalId: dto.journalId,
          replayed: true,
        };
      }
      throw new ConflictException(
        `clearing key '${computedKey}' was reset; supply a new postingKey to re-clear this item`,
      );
    }
    const liveClearings = await this.liveClearingSourceIds(dto.journalId);
    if (liveClearings.length > 0) {
      throw new ConflictException(`journal ${dto.journalId} is already cleared`);
    }

    let reconMoney: Money;
    try {
      reconMoney = Money.fromNumeric(recon.amount, docCurrency, this.registry);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    // Full-clearing only (v1): a supplied amount must equal the open item gross — no partial clear.
    if (dto.amount !== undefined) {
      let requested: Money;
      try {
        requested = Money.fromNumeric(dto.amount, docCurrency, this.registry);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      if (!requested.equals(reconMoney)) {
        throw new BadRequestException(
          `partial clearing is out of scope: amount ${dto.amount} must equal the open item gross ` +
            `${reconMoney.toNumeric()} ${docCurrency}`,
        );
      }
    }

    const bankAccount = await this.accountDetermination.resolve({
      transactionKey: BANK_CLEARING_KEY,
      chartOfAccounts: company.chartOfAccounts,
      companyCode: company.code,
    });
    // The cash leg is built in the OPEN ITEM's currency (v1 has no separate payment currency, so the
    // cash and recon legs always share it). A determination-resolved cash account that is currency-
    // PINNED to a different currency therefore cannot settle this item — reject early and clearly
    // (resolveLines would also reject it at post time; cross-currency payment is out of v1 scope).
    const bankGl = await this.glAccounts.getByNumber(company.chartOfAccounts, bankAccount);
    if (bankGl.currency && bankGl.currency !== docCurrency) {
      throw new BadRequestException(
        `cash/clearing account ${bankAccount} is fixed to ${bankGl.currency}; cannot clear a ` +
          `${docCurrency} item (cross-currency payment is out of v1 scope)`,
      );
    }

    // Sides: AR receipt debits cash and credits the receivable; AP payment credits cash and debits
    // the payable. The recon leg carries the partner (recon_partner_ck) and closes the open item.
    const cashDrCr = side === 'AR' ? ('D' as const) : ('C' as const);
    const reconDrCr = side === 'AR' ? ('C' as const) : ('D' as const);
    const documentDate = dto.documentDate ?? dto.postingDate;

    const lines: PostingLine[] = [];
    let fxRate: string | undefined;
    let realizedFx: ClearingResult['realizedFx'] = null;

    if (!isFx) {
      // Same currency: no realized FX, functional == document by construction.
      lines.push({ glAccount: bankAccount, drCr: cashDrCr, money: reconMoney });
      lines.push({
        glAccount: reconAccount,
        drCr: reconDrCr,
        money: reconMoney,
        partnerId: dto.partnerId,
      });
    } else {
      // The receivable/payable closes at its ORIGINAL invoice-date functional value (copied from the
      // open line); the cash leg sits at the settlement-date rate; realized FX rides the difference.
      let originalFunctional: Money;
      try {
        originalFunctional = Money.fromNumeric(recon.functionalAmount, functionalCurrency, this.registry);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      const resolved = await this.currencies.resolveRate(
        docCurrency,
        functionalCurrency,
        documentDate,
        'M',
      );
      fxRate = resolved.rate;
      let settlementFunctional: Money;
      try {
        settlementFunctional = reconMoney.convert(resolved.rate, functionalCurrency, this.registry);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }

      lines.push({
        glAccount: bankAccount,
        drCr: cashDrCr,
        money: reconMoney,
        functionalAmount: settlementFunctional,
      });
      lines.push({
        glAccount: reconAccount,
        drCr: reconDrCr,
        money: reconMoney,
        partnerId: dto.partnerId,
        functionalAmount: originalFunctional,
      });

      // Functional residue over cash + recon, on the short side, like the FX_ROUNDING plug but split
      // by sign into economic gain (credit) / loss (debit) keys. residue 0 ⇒ exact-rate clear.
      const debitFunc =
        (cashDrCr === 'D' ? settlementFunctional.minorUnits : 0n) +
        (reconDrCr === 'D' ? originalFunctional.minorUnits : 0n);
      const creditFunc =
        (cashDrCr === 'C' ? settlementFunctional.minorUnits : 0n) +
        (reconDrCr === 'C' ? originalFunctional.minorUnits : 0n);
      const residue = debitFunc - creditFunc;
      if (residue !== 0n) {
        const kind: 'GAIN' | 'LOSS' = residue > 0n ? 'GAIN' : 'LOSS';
        const realizedAccount = await this.accountDetermination.resolve({
          transactionKey: residue > 0n ? REALIZED_FX_GAIN_KEY : REALIZED_FX_LOSS_KEY,
          chartOfAccounts: company.chartOfAccounts,
          companyCode: company.code,
        });
        const magnitude = residue > 0n ? residue : -residue;
        lines.push({
          glAccount: realizedAccount,
          drCr: residue > 0n ? ('C' as const) : ('D' as const),
          money: Money.zero(docCurrency, this.registry),
          functionalAmount: Money.fromMinorUnits(magnitude, functionalCurrency, this.registry),
        });
        realizedFx = {
          account: realizedAccount,
          kind,
          amount: Money.fromMinorUnits(magnitude, functionalCurrency, this.registry).toNumeric(),
        };
      }
    }

    const docType = side === 'AR' ? DOC_TYPE_AR_CLEARING : DOC_TYPE_AP_CLEARING;
    const posted = await this.journals.post(
      {
        postingKey: computedKey,
        companyCodeId: dto.companyCodeId,
        postingDate: dto.postingDate,
        documentDate,
        docType,
        currency: docCurrency,
        fxRate,
        reference: dto.reference ?? `clearing:${invoice.docNo}`,
        headerText: dto.headerText,
        lines,
      },
      actor,
      {
        docFlowLinks: [{ targetType: DOC_FLOW_TYPE, targetId: dto.journalId, relType: REL_CLEARS }],
        eventType: 'finance.journal.cleared',
      },
    );

    return {
      ...posted,
      clearedJournalId: dto.journalId,
      side,
      docType,
      reconAccount,
      bankAccount,
      amount: reconMoney.toNumeric(),
      currency: docCurrency,
      realizedFx,
    };
  }

  /**
   * Reset-clearing (SAP FBRA): reverse the clearing document. `reverse()` copies functional amounts
   * verbatim, so the realized gain/loss is reversed exactly (no re-translation) and the entry nets to
   * zero in both currencies. The CLEARS edge's clearing doc becomes REVERSED ⇒ non-live ⇒ the open
   * item re-opens automatically. Idempotent: resetting an already-reset clearing returns the reset.
   */
  async reset(
    clearingId: string,
    dto: ResetClearingDto,
    actor = 'system',
  ): Promise<PostedJournalEntry> {
    const [clearing] = await this.db
      .select({ id: schema.journalEntry.id, docType: schema.journalEntry.docType })
      .from(schema.journalEntry)
      .where(eq(schema.journalEntry.id, clearingId));
    if (!clearing) throw new NotFoundException(`clearing ${clearingId} not found`);
    if (clearing.docType !== DOC_TYPE_AR_CLEARING && clearing.docType !== DOC_TYPE_AP_CLEARING) {
      throw new BadRequestException(`journal ${clearingId} is not a clearing document`);
    }
    return this.journals.reverse(clearingId, dto.reason, dto.postingDate, actor);
  }

  // ── internals ───────────────────────────────────────────────────────────────

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

  private async findEntryByKey(companyCodeId: string, postingKey: string) {
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

  /** journal_entry ids of clearing documents holding a LIVE (non-reversed) CLEARS edge on `journalId`. */
  private async liveClearingSourceIds(journalId: string): Promise<string[]> {
    const edges = await this.db
      .select({ sourceId: schema.docFlow.sourceId })
      .from(schema.docFlow)
      .where(and(eq(schema.docFlow.relType, REL_CLEARS), eq(schema.docFlow.targetId, journalId)));
    if (edges.length === 0) return [];
    const sources = edges.map((e) => e.sourceId);
    const live = await this.db
      .select({ id: schema.journalEntry.id })
      .from(schema.journalEntry)
      .where(and(inArray(schema.journalEntry.id, sources), eq(schema.journalEntry.status, 'POSTED')));
    return live.map((r) => r.id);
  }
}
