import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { Money, type PostingLine } from '@erp/kernel';
import type { CurrencyCode } from '@erp/shared';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { CurrencyService } from '../../master-data/currency/currency.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import { AccountDeterminationService } from '../../platform/admin-config/account-determination.service.js';
import { JournalService } from '../../finance-accounting/general-ledger/journal.service.js';
import {
  BANK_CLEARING_KEY,
  DOC_FLOW_TYPE_DRAWBACK_CLAIM,
  DOC_FLOW_TYPE_DRAWBACK_SOURCE_EXPORT,
  DOC_FLOW_TYPE_JOURNAL,
  DOC_TYPE_DRAWBACK_CLAIM,
  DRAWBACK_REFUND_ROUNDING,
  DUTY_DRAWBACK_INCOME_KEY,
  DUTY_DRAWBACK_RECEIVABLE_KEY,
  NUMBER_OBJECT_DRAWBACK_CLAIM,
  REL_POSTS,
  REL_REFUNDS,
} from '../trade-compliance.constants.js';
import { manualFobDeviationExceeds, simplifiedLineRefund, sumRefunds } from './duty-drawback-calc.js';
import {
  drawbackClaimWarnings,
  type DrawbackClaimWarning,
  type DrawbackLineGateState,
} from './duty-drawback-warnings.js';
import type {
  ApproveDrawbackClaimDto,
  CreateDrawbackClaimDto,
  DrawbackClaimQuery,
  ReceiptDrawbackClaimDto,
} from './duty-drawback.dto.js';

/** A computed claim line: the row to insert + its refund Money + the gate facts. */
interface ComputedLine {
  insert: {
    sourceExportDeclarationId: string;
    sourceExportDeclarationItemRef: string;
    sourceAcceptanceDate: string;
    hsCode: string;
    fobAmount: string;
    fobCurrency: string;
    fobKrwAmount: string;
    fxRate: string | null;
    appliedRate: string;
    lineRefundAmount: string;
  };
  refund: Money;
  gate: DrawbackLineGateState;
}

/**
 * Duty-drawback service (trade-compliance.duty-drawback = 관세환급, 간이정액) — the FIRST POSTING document of
 * the trade-compliance domain. A claim bundles source 수출신고 lines, computes the 간이정액 refund per line
 * (FOB→KRW at the 수리일 'M' rate, × 간이정액환급률 / 10,000), and on approve posts the FIRST real FI journal
 * (Dr 관세환급금 미수금 / Cr 관세환급수익, account-determination — never hard-coded). Lifecycle:
 * create (CLAIMED, **non-posting**) → approve (APPROVED, the FI journal; idempotent on the claim).
 *
 * Cross-domain reads are READ-ONLY (export_declaration / _item for the FOB·HS·수리일 snapshot, company for the
 * posting context) — export_declaration is never written. 환급금 입금 클리어링 + 개별환급 are later slices.
 */
@Injectable()
export class DutyDrawbackService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
    private readonly currencies: CurrencyService,
    private readonly registry: DbCurrencyRegistry,
    private readonly accountDetermination: AccountDeterminationService,
    private readonly journals: JournalService,
  ) {}

  async create(dto: CreateDrawbackClaimDto, actor = 'system') {
    const company = await this.getCompany(dto.companyCodeId);
    const functional = company.currency as CurrencyCode; // KRW for a KR company — the refund currency

    // Resolve every source 수출신고 (header + line), READ-ONLY: must exist, belong to the company, and the
    // item ref must belong to its declaration. Batched.
    const { headers, items } = await this.resolveSources(dto);

    const computed: ComputedLine[] = [];
    for (const [i, line] of dto.items.entries()) {
      const lineNo = i + 1;
      const header = headers.get(line.sourceExportDeclarationId)!; // resolveSources guarantees presence
      const item = items.get(line.sourceExportDeclarationItemRef)!;
      // A source line with NO HS (the export was filed without one — a SOFT condition there too, never a
      // 400) cannot match a 간이정액률. The claim still proceeds softly (refund 0 + a SOURCE_HS_MISSING
      // warning), never a hard block — consistent with the all-gates-soft mandate. '' is the deterministic
      // NOT-NULL snapshot for the rare missing case.
      const hsMissing = !item.hsCode;
      const hsCode = item.hsCode ?? '';
      const fobCurrency = item.currency;
      const acceptanceDate = header.acceptanceDate; // 수리일 (null until the export is 수리)

      // FOB → KRW. Manual 원화 FOB wins (fx_rate NULL); else domestic is the FOB itself; else auto-convert at
      // the 수리일 'M' rate. The auto value is needed as the line value ONLY when there is no manual override;
      // otherwise it is computed solely for the SOFT G3 deviation check, so a missing 수리일 rate is tolerated
      // (left null → G3 skipped) and only the genuine no-value path (foreign, neither a 수리일 rate nor a
      // manual override) is a hard error.
      let fobKrw: Money;
      let fxRate: string | null = null;
      let autoKrw: Money | null = null;
      if (fobCurrency !== functional) {
        if (acceptanceDate) {
          const rate = await this.resolveRateOrNull(fobCurrency, functional, acceptanceDate);
          if (rate) {
            autoKrw = Money.fromNumeric(item.fobAmount, fobCurrency as CurrencyCode, this.registry).convert(
              rate,
              functional,
              this.registry,
            );
            fxRate = rate;
          }
        }
        if (line.fobKrw != null) {
          fobKrw = this.toKrw(line.fobKrw, functional, lineNo);
          fxRate = null; // manual override: the stored rate would not reproduce the manual KRW
        } else if (autoKrw) {
          fobKrw = autoKrw;
        } else {
          throw new BadRequestException(
            `line ${lineNo}: foreign FOB (${fobCurrency}) cannot be valued — no 수리일 'M' rate ` +
              `(수리일 ${acceptanceDate ?? '미수리'}); provide a manual 원화 FOB (fobKrw) or accept the export first`,
          );
        }
      } else {
        // Domestic (functional-currency) FOB: already KRW; a manual override still wins for G3 comparison.
        const domesticKrw = Money.fromNumeric(item.fobAmount, functional, this.registry);
        autoKrw = domesticKrw;
        fobKrw = line.fobKrw != null ? this.toKrw(line.fobKrw, functional, lineNo) : domesticKrw;
      }

      // 간이정액환급률 (수리일 구간 매칭) — 0 when none / no 수리일.
      const appliedRate =
        acceptanceDate != null ? await this.resolveSimplifiedRate(hsCode, acceptanceDate) : null;
      const rate = appliedRate ?? '0';
      const refund = simplifiedLineRefund(fobKrw, rate, DRAWBACK_REFUND_ROUNDING);

      // G3 manual-vs-auto deviation (only when a manual override AND an auto value both exist).
      const manualFobDeviation =
        line.fobKrw != null && autoKrw != null
          ? manualFobDeviationExceeds(fobKrw, autoKrw)
          : null;

      computed.push({
        insert: {
          sourceExportDeclarationId: line.sourceExportDeclarationId,
          sourceExportDeclarationItemRef: line.sourceExportDeclarationItemRef,
          // Snapshot the 수리일 when present; when the export is not yet 수리, snapshot the claim date so the
          // NOT NULL column holds a deterministic value (the ACCEPTANCE_DATE_MISSING warning flags the gap).
          sourceAcceptanceDate: acceptanceDate ?? dto.claimDate,
          hsCode,
          fobAmount: Money.fromNumeric(item.fobAmount, fobCurrency as CurrencyCode, this.registry).toNumeric(),
          fobCurrency,
          fobKrwAmount: fobKrw.toNumeric(),
          fxRate,
          appliedRate: rate,
          lineRefundAmount: refund.toNumeric(),
        },
        refund,
        gate: {
          lineNo,
          sourceStatus: header.status,
          acceptanceDate,
          hsMissing,
          rateMatched: appliedRate != null,
          manualFobDeviation,
        },
      });
    }

    const claimedTotal = sumRefunds(
      computed.map((c) => c.refund),
      this.registry,
    );

    // SOFT, non-blocking warnings (G0 수리 상태 / G1 률 누락 / G2 환급기한 / G3 수동 FOB 편차).
    const warnings: DrawbackClaimWarning[] = drawbackClaimWarnings({
      claimDate: dto.claimDate,
      lines: computed.map((c) => c.gate),
    });

    const result = await this.db.transaction(async (tx) => {
      const docNo = await this.numbering.next(NUMBER_OBJECT_DRAWBACK_CLAIM, 'GLOBAL', tx);
      const [header] = await tx
        .insert(schema.drawbackClaim)
        .values({
          docType: DOC_TYPE_DRAWBACK_CLAIM,
          docNo,
          status: 'CLAIMED',
          companyCodeId: dto.companyCodeId,
          claimDate: dto.claimDate,
          claimedTotalAmount: claimedTotal.toNumeric(),
          claimedTotalCurrency: functional,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning({ id: schema.drawbackClaim.id });
      if (!header) throw new Error('drawback_claim insert returned no row');

      await tx.insert(schema.drawbackClaimItem).values(
        computed.map((c, i) => ({
          claimId: header.id,
          lineNo: i + 1,
          ...c.insert,
          createdBy: actor,
          updatedBy: actor,
        })),
      );

      // Lineage (§4.3): one REFUNDS edge per DISTINCT source 수출신고 (the partial-payment multi-edge
      // convention). NOT a journal — create posts nothing. Direction: claim → export_declaration.
      const distinctSources = [...new Set(dto.items.map((it) => it.sourceExportDeclarationId))];
      for (const sourceId of distinctSources) {
        await this.docFlow.link(
          {
            sourceType: DOC_FLOW_TYPE_DRAWBACK_CLAIM,
            sourceId: header.id,
            targetType: DOC_FLOW_TYPE_DRAWBACK_SOURCE_EXPORT,
            targetId: sourceId,
            relType: REL_REFUNDS,
          },
          tx,
        );
      }

      return {
        drawbackClaimId: header.id,
        docNo,
        status: 'CLAIMED' as const,
        claimedTotalAmount: claimedTotal.toNumeric(),
        claimedTotalCurrency: functional,
      };
    });

    return { ...result, warnings };
  }

  /**
   * approve (관세청 결정 → APPROVED) — the FIRST real FI journal in trade-compliance. Idempotent on the claim:
   * an already-APPROVED claim replays its live state (posts nothing); a non-CLAIMED claim 409s.
   *   Dr 관세환급금 미수금 (DUTY_DRAWBACK_RECEIVABLE)  approved_total
   *   Cr 관세환급수익     (DUTY_DRAWBACK_INCOME)      approved_total
   * KRW single-currency (KRW = functional), two-line, no FX. The journal is subledger-owned (claim —POSTS→).
   */
  async approve(id: string, dto: ApproveDrawbackClaimDto, actor = 'system') {
    const claim = await this.loadClaim(id);
    // Idempotent replay: an already-approved claim returns its live state, posting nothing (§5.2 — the
    // claim-level gate owns exactly-once, so the caller-tx journal post is never re-entered).
    if (claim.status === 'APPROVED') {
      return this.toApprovedResult(claim, true);
    }
    if (claim.status !== 'CLAIMED') {
      throw new ConflictException(
        `drawback claim ${id} is ${claim.status}; only a CLAIMED claim can be approved`,
      );
    }

    const company = await this.getCompany(claim.companyCodeId);
    const functional = company.currency as CurrencyCode;
    const approvedTotal = dto.approvedTotal
      ? this.toKrw(dto.approvedTotal, functional, undefined)
      : Money.fromNumeric(claim.claimedTotalAmount, functional, this.registry);
    if (approvedTotal.isZero()) {
      throw new BadRequestException(
        `drawback claim ${claim.docNo} approved total is 0 — nothing to post (every line resolved to 환급액 0)`,
      );
    }

    const postingKey = `drawback:${claim.id}:approve`;

    const result = await this.db.transaction(async (tx) => {
      // Atomic transition guard FIRST: only a still-CLAIMED row flips, so a concurrent approve cannot
      // double-post (the loser updates zero rows and 409s, rolling back before any journal is written).
      const [flipped] = await tx
        .update(schema.drawbackClaim)
        .set({
          status: 'APPROVED',
          approvalDate: dto.approvalDate,
          approvedTotalAmount: approvedTotal.toNumeric(),
          approvedTotalCurrency: functional,
          postingKey,
          updatedBy: actor,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.drawbackClaim.id, claim.id), eq(schema.drawbackClaim.status, 'CLAIMED')))
        .returning({ id: schema.drawbackClaim.id });
      if (!flipped) {
        throw new ConflictException(
          `drawback claim ${claim.docNo} is no longer CLAIMED — concurrent approval`,
        );
      }

      const receivableAccount = await this.accountDetermination.resolve(
        {
          transactionKey: DUTY_DRAWBACK_RECEIVABLE_KEY,
          chartOfAccounts: company.chartOfAccounts,
          companyCode: company.code,
        },
        tx,
      );
      const incomeAccount = await this.accountDetermination.resolve(
        {
          transactionKey: DUTY_DRAWBACK_INCOME_KEY,
          chartOfAccounts: company.chartOfAccounts,
          companyCode: company.code,
        },
        tx,
      );

      const lines: PostingLine[] = [
        { glAccount: receivableAccount, drCr: 'D', money: approvedTotal, lineText: '관세환급금 미수' },
        { glAccount: incomeAccount, drCr: 'C', money: approvedTotal, lineText: '관세환급수익' },
      ];
      const posted = await this.journals.post(
        {
          postingKey,
          companyCodeId: claim.companyCodeId,
          postingDate: dto.approvalDate,
          currency: functional,
          reference: `trade.drawback_claim:${claim.docNo}`,
          headerText: `관세환급 ${claim.docNo}`,
          lines,
        },
        actor,
        { tx },
      );

      // Subledger-owned: claim —POSTS→ journal (the FI reverse-guard refuses a bare GL reversal).
      await this.docFlow.link(
        {
          sourceType: DOC_FLOW_TYPE_DRAWBACK_CLAIM,
          sourceId: claim.id,
          targetType: DOC_FLOW_TYPE_JOURNAL,
          targetId: posted.journalId,
          relType: REL_POSTS,
        },
        tx,
      );

      return {
        drawbackClaimId: claim.id,
        docNo: claim.docNo,
        status: 'APPROVED' as const,
        journalId: posted.journalId,
        approvedTotalAmount: approvedTotal.toNumeric(),
        approvedTotalCurrency: functional,
        replayed: false,
      };
    });

    return result;
  }

  /**
   * receipt (관세청 입금 → PAID) — the MIRROR of approve(): the FI journal that CLOSES the receivable approve
   * opened, so the 1140 미수금 nets to 0 and the cycle completes. Idempotent on the claim: an already-PAID
   * claim replays its live state (posts nothing); a non-APPROVED claim 409s (a CLAIMED claim must be
   * approved first).
   *   Dr 보통예금 (BANK_CLEARING)                      received(=approved_total)
   *   Cr 관세환급금 미수금 (DUTY_DRAWBACK_RECEIVABLE)   received(=approved_total)
   * KRW single-currency (KRW = functional), two-line, no FX. The journal is subledger-owned (claim —POSTS→),
   * so a correction goes through a future receipt-cancel, never a bare GL reversal. v1 = FULL receipt only.
   */
  async receipt(id: string, dto: ReceiptDrawbackClaimDto, actor = 'system') {
    const claim = await this.loadClaim(id);
    // Idempotent replay: an already-paid claim returns its live state, posting nothing (§5.2 — the
    // claim-level status guard owns exactly-once, so the caller-tx journal post is never re-entered).
    if (claim.status === 'PAID') {
      return this.toPaidResult(claim, true);
    }
    if (claim.status !== 'APPROVED') {
      throw new ConflictException(
        `drawback claim ${claim.docNo} is ${claim.status}; only an APPROVED claim can be 입금처리 (승인 먼저)`,
      );
    }

    const company = await this.getCompany(claim.companyCodeId);
    const functional = company.currency as CurrencyCode;
    // approve guaranteed the approved total is non-null and non-zero; guard defensively before the Money parse.
    if (!claim.approvedTotalAmount) {
      throw new ConflictException(
        `drawback claim ${claim.docNo} is APPROVED but has no approved total — cannot 입금처리`,
      );
    }
    const approvedTotal = Money.fromNumeric(claim.approvedTotalAmount, functional, this.registry);
    if (approvedTotal.isZero()) {
      throw new BadRequestException(
        `drawback claim ${claim.docNo} approved total is 0 — nothing to settle`,
      );
    }

    // Full-receipt only (v1): a supplied 입금액 must equal the approved total — no partial receipt (the
    // clearing slice's full-clearing reject pattern). fromNumeric (not Money.of) so a canonical '5000.0000'
    // KRW input is accepted while genuine sub-won precision ('5000.5') still 400s.
    if (dto.receivedAmount !== undefined) {
      let received: Money;
      try {
        received = Money.fromNumeric(dto.receivedAmount, functional, this.registry);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
      if (!received.equals(approvedTotal)) {
        throw new BadRequestException(
          `부분입금은 스코프 밖: 입금액 ${dto.receivedAmount} must equal the approved total ` +
            `${approvedTotal.toNumeric()} ${functional}`,
        );
      }
    }

    const postingKey = `drawback:${claim.id}:receipt`;

    const result = await this.db.transaction(async (tx) => {
      // Atomic transition guard FIRST: only a still-APPROVED row flips, so a concurrent receipt cannot
      // double-post (the loser updates zero rows and 409s, rolling back before any journal is written).
      const [flipped] = await tx
        .update(schema.drawbackClaim)
        .set({
          status: 'PAID',
          receiptDate: dto.receiptDate,
          receivedAmount: approvedTotal.toNumeric(),
          receivedCurrency: functional,
          postingKey,
          updatedBy: actor,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.drawbackClaim.id, claim.id), eq(schema.drawbackClaim.status, 'APPROVED')))
        .returning({ id: schema.drawbackClaim.id });
      if (!flipped) {
        throw new ConflictException(
          `drawback claim ${claim.docNo} is no longer APPROVED — concurrent receipt`,
        );
      }

      const bankAccount = await this.accountDetermination.resolve(
        {
          transactionKey: BANK_CLEARING_KEY,
          chartOfAccounts: company.chartOfAccounts,
          companyCode: company.code,
        },
        tx,
      );
      const receivableAccount = await this.accountDetermination.resolve(
        {
          transactionKey: DUTY_DRAWBACK_RECEIVABLE_KEY,
          chartOfAccounts: company.chartOfAccounts,
          companyCode: company.code,
        },
        tx,
      );

      const lines: PostingLine[] = [
        { glAccount: bankAccount, drCr: 'D', money: approvedTotal, lineText: '관세환급금 입금' },
        { glAccount: receivableAccount, drCr: 'C', money: approvedTotal, lineText: '관세환급금 미수 소거' },
      ];
      const posted = await this.journals.post(
        {
          postingKey,
          companyCodeId: claim.companyCodeId,
          postingDate: dto.receiptDate,
          currency: functional,
          reference: `trade.drawback_claim:${claim.docNo}`,
          headerText: `관세환급입금 ${claim.docNo}`,
          lines,
        },
        actor,
        { tx },
      );

      // Subledger-owned: claim —POSTS→ journal (the FI reverse-guard refuses a bare GL reversal). This is the
      // SECOND POSTS edge on the claim (approve wrote the first) — so replay recovers THIS journal by its
      // deterministic posting key, never by scanning POSTS edges (which would ambiguously hit the approve one).
      await this.docFlow.link(
        {
          sourceType: DOC_FLOW_TYPE_DRAWBACK_CLAIM,
          sourceId: claim.id,
          targetType: DOC_FLOW_TYPE_JOURNAL,
          targetId: posted.journalId,
          relType: REL_POSTS,
        },
        tx,
      );

      return {
        drawbackClaimId: claim.id,
        docNo: claim.docNo,
        status: 'PAID' as const,
        journalId: posted.journalId,
        receivedAmount: approvedTotal.toNumeric(),
        receivedCurrency: functional,
        replayed: false,
      };
    });

    return result;
  }

  /** Header + items (line order) + outward lineage edges, or 404. */
  async getDrawbackClaim(id: string) {
    const claim = await this.loadClaim(id);
    const items = await this.db
      .select()
      .from(schema.drawbackClaimItem)
      .where(eq(schema.drawbackClaimItem.claimId, id))
      .orderBy(asc(schema.drawbackClaimItem.lineNo));
    const lineage = await this.docFlow.forward(DOC_FLOW_TYPE_DRAWBACK_CLAIM, id);
    return { ...claim, items, lineage };
  }

  async listDrawbackClaims(q: DrawbackClaimQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.drawbackClaim)
      .where(this.listWhere(q))
      .orderBy(desc(schema.drawbackClaim.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countDrawbackClaims(q: DrawbackClaimQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.drawbackClaim)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: DrawbackClaimQuery) {
    return and(
      q.companyCodeId ? eq(schema.drawbackClaim.companyCodeId, q.companyCodeId) : undefined,
      q.status ? eq(schema.drawbackClaim.status, q.status) : undefined,
    );
  }

  private async loadClaim(id: string) {
    const [claim] = await this.db
      .select()
      .from(schema.drawbackClaim)
      .where(eq(schema.drawbackClaim.id, id));
    if (!claim) throw new NotFoundException(`drawback claim ${id} not found`);
    return claim;
  }

  /** The journal a posted claim raised (its POSTS edge) + the live approved-state response (replay). */
  private async toApprovedResult(claim: typeof schema.drawbackClaim.$inferSelect, replayed: boolean) {
    const edges = await this.docFlow.forward(DOC_FLOW_TYPE_DRAWBACK_CLAIM, claim.id);
    const journalId = edges.find((e) => e.relType === REL_POSTS)?.targetId ?? '';
    return {
      drawbackClaimId: claim.id,
      docNo: claim.docNo,
      status: 'APPROVED' as const,
      journalId,
      approvedTotalAmount: claim.approvedTotalAmount ?? '',
      approvedTotalCurrency: claim.approvedTotalCurrency ?? '',
      replayed,
    };
  }

  /**
   * The receipt journal + the live PAID-state response (replay). A PAID claim carries TWO POSTS edges
   * (approve's + receipt's), so the journal is recovered by its DETERMINISTIC posting key — not by scanning
   * POSTS edges, which would ambiguously match the approve journal (see receipt()).
   */
  private async toPaidResult(claim: typeof schema.drawbackClaim.$inferSelect, replayed: boolean) {
    const [journal] = await this.db
      .select({ id: schema.journalEntry.id })
      .from(schema.journalEntry)
      .where(
        and(
          eq(schema.journalEntry.companyCodeId, claim.companyCodeId),
          eq(schema.journalEntry.postingKey, `drawback:${claim.id}:receipt`),
        ),
      );
    return {
      drawbackClaimId: claim.id,
      docNo: claim.docNo,
      status: 'PAID' as const,
      journalId: journal?.id ?? '',
      receivedAmount: claim.receivedAmount ?? '',
      receivedCurrency: claim.receivedCurrency ?? '',
      replayed,
    };
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

  /** Build a KRW Money from a manual amount string, mapping a precision error (a decimal on KRW) to a 400. */
  private toKrw(amount: string, functional: CurrencyCode, lineNo: number | undefined): Money {
    try {
      return Money.of(amount, functional, this.registry);
    } catch (err) {
      const where = lineNo != null ? `line ${lineNo}: ` : '';
      throw new BadRequestException(`${where}${(err as Error).message}`);
    }
  }

  /**
   * Resolve the source 수출신고 headers + items for a create, READ-ONLY. Validates existence, company
   * ownership, and that each item ref belongs to its declaration. Returns lookup maps.
   */
  private async resolveSources(dto: CreateDrawbackClaimDto): Promise<{
    headers: Map<string, { id: string; status: string; acceptanceDate: string | null; currency: string; companyCodeId: string }>;
    items: Map<string, { id: string; declarationId: string; hsCode: string | null; fobAmount: string; currency: string }>;
  }> {
    const declIds = [...new Set(dto.items.map((i) => i.sourceExportDeclarationId))];
    const decls = await this.db
      .select({
        id: schema.exportDeclaration.id,
        status: schema.exportDeclaration.status,
        acceptanceDate: schema.exportDeclaration.acceptanceDate,
        currency: schema.exportDeclaration.currency,
        companyCodeId: schema.exportDeclaration.companyCodeId,
      })
      .from(schema.exportDeclaration)
      .where(inArray(schema.exportDeclaration.id, declIds));
    const headers = new Map(decls.map((d) => [d.id, d]));
    for (const declId of declIds) {
      const d = headers.get(declId);
      if (!d) throw new NotFoundException(`source export declaration ${declId} not found`);
      if (d.companyCodeId !== dto.companyCodeId) {
        throw new BadRequestException(
          `source export declaration ${declId} belongs to another company code`,
        );
      }
    }

    const itemIds = [...new Set(dto.items.map((i) => i.sourceExportDeclarationItemRef))];
    const itemRows = await this.db
      .select({
        id: schema.exportDeclarationItem.id,
        declarationId: schema.exportDeclarationItem.declarationId,
        hsCode: schema.exportDeclarationItem.hsCode,
        fobAmount: schema.exportDeclarationItem.fobAmount,
        currency: schema.exportDeclarationItem.currency,
      })
      .from(schema.exportDeclarationItem)
      .where(inArray(schema.exportDeclarationItem.id, itemIds));
    const items = new Map(itemRows.map((it) => [it.id, it]));
    for (const line of dto.items) {
      const it = items.get(line.sourceExportDeclarationItemRef);
      if (!it) {
        throw new NotFoundException(
          `source export declaration item ${line.sourceExportDeclarationItemRef} not found`,
        );
      }
      if (it.declarationId !== line.sourceExportDeclarationId) {
        throw new BadRequestException(
          `export item ${it.id} does not belong to declaration ${line.sourceExportDeclarationId}`,
        );
      }
    }
    return { headers, items };
  }

  /** Most-recent 간이정액환급률 effective on `onDate` for `hsCode`, or null (→ applied_rate 0 + G1). */
  private async resolveSimplifiedRate(hsCode: string, onDate: string): Promise<string | null> {
    const [row] = await this.db
      .select({ ratePer10k: schema.drawbackSimplifiedRate.ratePer10k })
      .from(schema.drawbackSimplifiedRate)
      .where(
        and(
          eq(schema.drawbackSimplifiedRate.hsCode, hsCode),
          lte(schema.drawbackSimplifiedRate.validFrom, onDate),
          or(
            isNull(schema.drawbackSimplifiedRate.validTo),
            gte(schema.drawbackSimplifiedRate.validTo, onDate),
          ),
        ),
      )
      .orderBy(desc(schema.drawbackSimplifiedRate.validFrom))
      .limit(1);
    return row?.ratePer10k ?? null;
  }

  /**
   * The 'M' rate for `from`→`to` on `onDate`, or null when no rate covers it (resolveRate throws a
   * NotFoundException). Used so a manual 원화 FOB override can bypass FX entirely — a missing rate is fatal
   * only on the no-value path (foreign line, no manual override), checked by the caller.
   */
  private async resolveRateOrNull(
    from: string,
    to: string,
    onDate: string,
  ): Promise<string | null> {
    try {
      return (await this.currencies.resolveRate(from, to, onDate, 'M')).rate;
    } catch (err) {
      if (err instanceof NotFoundException) return null;
      throw err;
    }
  }
}
