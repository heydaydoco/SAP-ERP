import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { Money, type PostingLine } from '@erp/kernel';
import type { CurrencyCode } from '@erp/shared';
import { DB } from '../../../database/database.module.js';
import { AccountDeterminationService } from '../../platform/admin-config/account-determination.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { BusinessPartnerService } from '../../master-data/business-partner/business-partner.service.js';
import { CurrencyService } from '../../master-data/currency/currency.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import {
  DOC_FLOW_TYPE as DOC_FLOW_TYPE_JOURNAL,
  DOC_TYPE_AP_INVOICE,
  JournalService,
} from '../../finance-accounting/general-ledger/journal.service.js';
import {
  DOC_FLOW_TYPE_FREIGHT_SETTLEMENT,
  DOC_FLOW_TYPE_SHIPMENT,
  DOC_TYPE_FREIGHT,
  FREIGHT_KEY,
  NUMBER_OBJECT_FREIGHT,
  REL_POSTS,
  REL_SETTLES,
} from '../logistics-4pl.constants.js';
import type { CreateFreightSettlementDto, FreightSettlementQuery } from './freight-settlement.dto.js';

export interface PostedFreightSettlement {
  freightSettlementId: string;
  docNo: string;
  status: 'POSTED';
  /** The AP open item this freight raised (a `KR` journal — the journal IS the AP document, D4). */
  journalId: string;
  reconAccount: string;
  currency: string;
  /** Total freight settled, document currency. */
  freightAmount: string;
  replayed?: boolean;
}

/**
 * Freight settlement (logistics-4pl.freight-settlement) — the 4PL domain's FIRST FI document. Attaches a
 * forwarder's freight to a shipment (선적, the previous non-posting slice's backbone) and raises an AP open
 * item, posting ONE `KR` journal (the journal IS the AP document, like landed-cost — no separate ap_invoice
 * store):
 *
 *   Dr 지급운임 (FREIGHT account-determination)
 *   Cr AP recon (+forwarder partner, substituted from the vendor role)
 *
 * No VAT in v1 (a foreign forwarder's export freight is 국외제공용역/영세율). FX is delegated WHOLLY to
 * `JournalService.post`: the service resolves the document-date 'M' rate (or honors an explicit `fxRate`),
 * stamps the header rate, and hands the rate + a functional-amount on the recon leg to `post`, which
 * translates and ties out in both currencies (no FX_ROUNDING residue on a 2-line entry). Idempotent on
 * `posting_key` (gate `freight_settlement_posting_key_uq`); the journal key is `<key>:je` (per-document, fresh
 * — a caller-tx post needs a key that never collides with the freight key). Two doc_flow edges: SETTLES →
 * shipment (lineage) and POSTS → journal (subledger-owned → FI reverse refused; correction is a future cancel).
 *
 * Cross-domain reads are READ-ONLY (the shipment, for existence + company check) — never a write into another
 * domain's tables. Payment/clearing is untouched (the existing clearing slice settles the KR open item).
 */
@Injectable()
export class FreightSettlementService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly journals: JournalService,
    private readonly partners: BusinessPartnerService,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
    private readonly accountDetermination: AccountDeterminationService,
    private readonly registry: DbCurrencyRegistry,
    private readonly currencies: CurrencyService,
  ) {}

  async post(dto: CreateFreightSettlementDto, actor = 'system'): Promise<PostedFreightSettlement> {
    const computedKey = dto.postingKey ?? `freight:${randomUUID()}`;

    // Idempotency (§5.2): a replay of the same key returns the existing document's live state.
    const existing = await this.findByKey(dto.companyCodeId, computedKey);
    if (existing) return this.toResult(existing, true);

    const company = await this.getCompany(dto.companyCodeId);
    const functionalCurrency = company.currency as CurrencyCode;
    const docCurrency = dto.currency as CurrencyCode;
    const isFx = docCurrency !== functionalCurrency;

    // Shipment (READ-ONLY): must exist and belong to this company. Lineage is the doc_flow SETTLES edge
    // written below — there is no cross-domain FK (the graph is generic, like shipment_item.delivery_id).
    const [ship] = await this.db
      .select({
        id: schema.shipment.id,
        docNo: schema.shipment.docNo,
        companyCodeId: schema.shipment.companyCodeId,
      })
      .from(schema.shipment)
      .where(eq(schema.shipment.id, dto.shipmentId));
    if (!ship) throw new NotFoundException(`shipment ${dto.shipmentId} not found`);
    if (ship.companyCodeId !== dto.companyCodeId) {
      throw new BadRequestException(`shipment ${ship.docNo} belongs to another company code`);
    }

    // AP recon substitution from the forwarder vendor role (never from the DTO).
    const bp = await this.partners.getBp(dto.forwarderBpId);
    if (!bp.vendor) {
      throw new BadRequestException(`forwarder ${dto.forwarderBpId} has no vendor (AP) role`);
    }
    const reconAccount = bp.vendor.apReconAccount;

    const freightMoney = Money.of(dto.freightAmount, docCurrency, this.registry);

    // The freight expense account — never hard-coded (§4.5).
    const freightExpenseAccount = await this.accountDetermination.resolve({
      transactionKey: FREIGHT_KEY,
      chartOfAccounts: company.chartOfAccounts,
      companyCode: company.code,
    });

    // FX: resolve the document-date 'M' rate (or honor the override) only to stamp the header + carry the
    // recon leg's functional amount. All translation/tie-out is JournalService.post's job (no FX math here).
    let rate: string | undefined;
    let exchangeRate: string | null = null;
    if (isFx) {
      rate =
        dto.fxRate ??
        (await this.currencies.resolveRate(docCurrency, functionalCurrency, dto.documentDate, 'M'))
          .rate;
      exchangeRate = rate;
    }

    const lines: PostingLine[] = [
      { glAccount: freightExpenseAccount, drCr: 'D', money: freightMoney, lineText: '지급운임' },
      {
        glAccount: reconAccount,
        drCr: 'C',
        money: freightMoney,
        partnerId: dto.forwarderBpId,
        // On an FX invoice the recon leg carries its functional amount so the 2-line entry ties out in
        // both currencies (the Dr leg translates at the same rate) — no FX_ROUNDING residue.
        functionalAmount: isFx
          ? freightMoney.convert(rate!, functionalCurrency, this.registry)
          : undefined,
      },
    ];

    try {
      return await this.db.transaction(async (tx) => {
        const docNo = await this.numbering.next(NUMBER_OBJECT_FREIGHT, 'GLOBAL', tx);
        const [header] = await tx
          .insert(schema.freightSettlement)
          .values({
            docType: DOC_TYPE_FREIGHT,
            docNo,
            status: 'POSTED',
            postingKey: computedKey,
            companyCodeId: dto.companyCodeId,
            shipmentId: dto.shipmentId,
            forwarderBpId: dto.forwarderBpId,
            currency: docCurrency,
            exchangeRate,
            freightAmount: freightMoney.toNumeric(),
            postingDate: dto.postingDate,
            documentDate: dto.documentDate,
            reference: dto.reference ?? null,
            headerText: dto.headerText ?? null,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning({ id: schema.freightSettlement.id });
        if (!header) throw new Error('freight_settlement insert returned no row');

        // The journal IS the AP document (KR). Caller-tx mode (§5.2): it commits iff this freight tx does;
        // a FRESH key (`<key>:je`) so it never collides with the freight posting key. fxRate FX-only.
        const posted = await this.journals.post(
          {
            postingKey: `${computedKey}:je`,
            companyCodeId: dto.companyCodeId,
            postingDate: dto.postingDate,
            documentDate: dto.documentDate,
            docType: DOC_TYPE_AP_INVOICE,
            currency: docCurrency,
            fxRate: isFx ? rate : undefined,
            reference: dto.reference ?? `${DOC_FLOW_TYPE_FREIGHT_SETTLEMENT}:${docNo}`,
            headerText: dto.headerText,
            lines,
          },
          actor,
          { tx },
        );

        // Lineage in THIS tx (exists iff the freight commits). POSTS → journal makes the KR journal
        // subledger-owned (FI reverse refused); SETTLES → shipment is the drill-down to the 선적.
        await this.docFlow.link(
          {
            sourceType: DOC_FLOW_TYPE_FREIGHT_SETTLEMENT,
            sourceId: header.id,
            targetType: DOC_FLOW_TYPE_JOURNAL,
            targetId: posted.journalId,
            relType: REL_POSTS,
          },
          tx,
        );
        await this.docFlow.link(
          {
            sourceType: DOC_FLOW_TYPE_FREIGHT_SETTLEMENT,
            sourceId: header.id,
            targetType: DOC_FLOW_TYPE_SHIPMENT,
            targetId: dto.shipmentId,
            relType: REL_SETTLES,
          },
          tx,
        );

        return {
          freightSettlementId: header.id,
          docNo,
          status: 'POSTED' as const,
          journalId: posted.journalId,
          reconAccount,
          currency: docCurrency,
          freightAmount: freightMoney.toNumeric(),
          replayed: false,
        };
      });
    } catch (e) {
      // Concurrent duplicate post: the UNIQUE(company, posting_key) gate fired — replay the winner. The
      // loser blocks on the freight header insert and never reaches journal.post, so no journal collides.
      if (isUniqueViolation(e, 'freight_settlement_posting_key_uq')) {
        const winner = await this.findByKey(dto.companyCodeId, computedKey);
        if (winner) return this.toResult(winner, true);
      }
      throw e;
    }
  }

  /** Header + `journalId` (from the POSTS doc_flow edge), or 404. */
  async getFreightSettlement(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.freightSettlement)
      .where(eq(schema.freightSettlement.id, id));
    if (!header) throw new NotFoundException(`freight settlement ${id} not found`);
    return { ...header, journalId: await this.journalIdOf(id) };
  }

  /** A shipment's freight settlements (drill-down), in doc order. */
  async listForShipment(shipmentId: string) {
    return this.db
      .select()
      .from(schema.freightSettlement)
      .where(eq(schema.freightSettlement.shipmentId, shipmentId))
      .orderBy(asc(schema.freightSettlement.docNo));
  }

  async listFreightSettlements(q: FreightSettlementQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.freightSettlement)
      .where(this.listWhere(q))
      .orderBy(desc(schema.freightSettlement.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countFreightSettlements(q: FreightSettlementQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.freightSettlement)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: FreightSettlementQuery) {
    return and(
      q.companyCodeId ? eq(schema.freightSettlement.companyCodeId, q.companyCodeId) : undefined,
      q.shipmentId ? eq(schema.freightSettlement.shipmentId, q.shipmentId) : undefined,
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

  /** The journal a freight settlement POSTS — the single forward POSTS edge (SETTLES has a different relType). */
  private async journalIdOf(freightSettlementId: string): Promise<string | null> {
    const edges = await this.docFlow.forward(DOC_FLOW_TYPE_FREIGHT_SETTLEMENT, freightSettlementId);
    return edges.find((e) => e.relType === REL_POSTS)?.targetId ?? null;
  }

  private async findByKey(companyCodeId: string, postingKey: string) {
    const [row] = await this.db
      .select()
      .from(schema.freightSettlement)
      .where(
        and(
          eq(schema.freightSettlement.companyCodeId, companyCodeId),
          eq(schema.freightSettlement.postingKey, postingKey),
        ),
      );
    return row;
  }

  /** Reconstruct the response from a stored freight settlement (idempotent replay). */
  private async toResult(
    row: typeof schema.freightSettlement.$inferSelect,
    replayed = false,
  ): Promise<PostedFreightSettlement> {
    const bp = await this.partners.getBp(row.forwarderBpId);
    return {
      freightSettlementId: row.id,
      docNo: row.docNo,
      status: 'POSTED',
      journalId: (await this.journalIdOf(row.id)) ?? '',
      reconAccount: bp.vendor?.apReconAccount ?? '',
      currency: row.currency,
      freightAmount: row.freightAmount,
      replayed,
    };
  }
}

/** True iff `e` is the Postgres unique violation for the named constraint. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint_name?: unknown };
  return err.code === '23505' && err.constraint_name === constraint;
}
