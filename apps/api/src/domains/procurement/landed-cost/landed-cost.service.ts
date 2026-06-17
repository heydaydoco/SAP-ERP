import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
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
  GoodsMovementService,
  type LandedCostAllocation,
} from '../../inventory-warehouse/goods-movement/goods-movement.service.js';
import { ProcurementQueryService } from '../procurement-query.service.js';
import {
  DOC_FLOW_TYPE_LANDED_COST,
  DOC_FLOW_TYPE_PO_ITEM,
  DOC_TYPE_LANDED_COST,
  NUMBER_OBJECT_LANDED_COST,
  PRD_KEY,
  REALIZED_FX_GAIN_KEY,
  REALIZED_FX_LOSS_KEY,
  REL_CAPITALIZES,
  REL_POSTS,
} from '../procurement.constants.js';
import { allocateByBasis } from './landed-cost-allocation.js';
import type { CreateLandedCostDto } from './landed-cost.dto.js';

export interface PostedLandedCost {
  landedCostId: string;
  docNo: string;
  status: 'POSTED';
  /** The AP open item this landed cost raised (a `KR` journal — D4, the journal IS the AP document). */
  journalId: string;
  reconAccount: string;
  currency: string;
  /** Total incidental cost capitalized/allocated, document currency. */
  costAmount: string;
  /** Customs-paid import VAT (functional KRW) — booked to 부가세대급금, NOT capitalized. */
  importVatAmount: string;
  /** Σ capitalized onto stock_value (functional KRW) — what raised BSX/MAP. */
  totalCovered: string;
  /** Σ expensed to 재고원가차이/PRD (functional KRW) — the share whose stock was already issued. */
  totalPrd: string;
  replayed?: boolean;
}

/**
 * Landed cost (procurement.landed-cost = SAP MM subsequent-debit). The actual-cost document that
 * capitalizes import incidental costs (관세·운임·보험·통관수수료) into the received stock's value and
 * books the customs-paid import VAT — in ONE transaction (§5.2), posting ONE `KR` journal.
 *
 *   Dr BSX (covered share)        ← value-only revaluation of material_valuation (qty unchanged, MAP up)
 *   Dr 재고원가차이 PRD (uncovered) ← the share whose stock was already issued before the cost arrived
 *   Dr 부가세대급금 1350           ← customs-paid import VAT (입력값, NOT capitalized — 매입세액공제)
 *   Cr AP recon (+forwarder/관세사) ← the gross open payable
 *   [+ realized FX residue 9810/9820 for a foreign-currency cost invoice]
 *
 * Mirrors the IV orchestrator: idempotency gate, recon-account substitution from the vendor role,
 * a single import PO, the in-tx write set (header + items + journal + doc_flow). The actual stock_value
 * write + the journal post happen inside `GoodsMovementService.revaluateValue(..., tx)` (inventory
 * stays the single writer of material_valuation → FI); this service computes the allocation and the
 * AP/VAT offset, owns the tx and the landed_cost document, and links the CAPITALIZES lineage.
 *
 * Allocation: the cost total is spread across the PO's received lines by RECEIVED FUNCTIONAL VALUE
 * (FOB-basis proxy — v1 value-proportional, weight/volume deferred), largest-remainder so Σ shares ==
 * the total exactly. Foreign incidental costs translate to KRW at the document-date 'M' rate before
 * capitalizing (Option-P). Import VAT is supplied DIRECTLY from the 수입세금계산서 (base = CIF+관세),
 * never via the net×rate tax-line builder, and is only valid on a functional-currency document.
 */
@Injectable()
export class LandedCostService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly movements: GoodsMovementService,
    private readonly partners: BusinessPartnerService,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
    private readonly accountDetermination: AccountDeterminationService,
    private readonly query: ProcurementQueryService,
    private readonly registry: DbCurrencyRegistry,
    private readonly currencies: CurrencyService,
  ) {}

  async post(dto: CreateLandedCostDto, actor = 'system'): Promise<PostedLandedCost> {
    const computedKey = dto.postingKey ?? `lc:${randomUUID()}`;

    // Idempotency (§5.2): a replay of the same key returns the existing document's live state.
    const existing = await this.findByKey(dto.companyCodeId, computedKey);
    if (existing) return this.toResult(existing, true);

    const company = await this.getCompany(dto.companyCodeId);
    const functionalCurrency = company.currency as CurrencyCode;
    const docCurrency = dto.currency as CurrencyCode;
    const isFx = docCurrency !== functionalCurrency;

    const [po] = await this.db
      .select()
      .from(schema.purchaseOrder)
      .where(eq(schema.purchaseOrder.id, dto.purchaseOrderId));
    if (!po) throw new NotFoundException(`purchase order ${dto.purchaseOrderId} not found`);
    if (po.companyCodeId !== dto.companyCodeId) {
      throw new BadRequestException(`purchase order ${po.docNo} belongs to another company code`);
    }

    // Import VAT (수입부가세) is customs-paid, functional-currency, NOT capitalized. A foreign forwarder
    // freight invoice carries no customs VAT — that rides the separate KRW 관세사 settlement.
    const importVat = Money.fromNumeric(dto.importVatAmount ?? '0', functionalCurrency, this.registry);
    if (!importVat.isZero()) {
      if (isFx) {
        throw new BadRequestException(
          'import VAT must be entered on a functional-currency landed-cost document ' +
            '(a foreign cost invoice carries no customs VAT — book it on the KR 관세사 settlement)',
        );
      }
      if (!dto.vatTaxCode) {
        throw new BadRequestException('vatTaxCode is required when importVatAmount > 0');
      }
    }

    // AP recon substitution from the forwarder/관세사 vendor role (never from the DTO).
    const bp = await this.partners.getBp(dto.vendorBpId);
    if (!bp.vendor) {
      throw new BadRequestException(`vendor ${dto.vendorBpId} has no vendor (AP) role`);
    }
    const reconAccount = bp.vendor.apReconAccount;

    // Allocation targets: the PO's received lines (received qty > 0). The basis is the GR-booked
    // functional (KRW) value the engine posted to BSX/WRX (D4-derived).
    const poItems = await this.db
      .select()
      .from(schema.purchaseOrderItem)
      .where(eq(schema.purchaseOrderItem.purchaseOrderId, po.id))
      .orderBy(asc(schema.purchaseOrderItem.lineNo));
    const received = await this.query.receivedByPoItem(poItems.map((i) => i.id));
    const targets = poItems
      .map((poItem) => ({ poItem, recv: received.get(poItem.id) }))
      .filter((t) => t.recv && t.recv.qty6 > 0n);
    if (targets.length === 0) {
      throw new BadRequestException(
        `nothing received against purchase order ${po.docNo} to capitalize landed cost onto`,
      );
    }

    // Spread the cost total across the received lines by received functional value (largest-remainder,
    // line_no tie-break) — Σ shares == the total exactly. Foreign cost translates to KRW (Option-P).
    const costTotal = Money.of(dto.costAmount, docCurrency, this.registry);
    const shares = allocateByBasis(
      costTotal,
      targets.map((t) => ({
        basisMinor: Money.fromNumeric(t.recv!.amount, functionalCurrency, this.registry).minorUnits,
        lineNo: t.poItem.lineNo,
      })),
    );

    let fxRate: string | undefined;
    let exchangeRate: string | null = null;
    if (isFx) {
      const resolved = await this.currencies.resolveRate(
        docCurrency,
        functionalCurrency,
        dto.documentDate,
        'M',
      );
      fxRate = resolved.rate;
      exchangeRate = resolved.rate;
    }

    const allocations: LandedCostAllocation[] = targets.map((t, i) => {
      const shareDoc = shares[i]!;
      return {
        materialId: t.poItem.materialId,
        plantId: t.poItem.plantId,
        purchaseOrderItemId: t.poItem.id,
        lineNo: t.poItem.lineNo,
        receivedQty6: t.recv!.qty6,
        receivedFunctionalValue: Money.fromNumeric(t.recv!.amount, functionalCurrency, this.registry),
        shareDoc,
        shareFunctional: isFx
          ? shareDoc.convert(fxRate!, functionalCurrency, this.registry)
          : shareDoc,
      };
    });

    // Offset lines: the import-VAT debit (domestic only) + the gross AP credit (with the partner).
    const offsetLines: PostingLine[] = [];
    if (!importVat.isZero()) {
      const vatAccount = await this.resolveImportVatAccount(dto.vatTaxCode!);
      offsetLines.push({
        glAccount: vatAccount,
        drCr: 'D',
        money: importVat,
        taxCode: dto.vatTaxCode,
        lineText: '수입부가세',
      });
    }
    const grossDoc = isFx ? costTotal : costTotal.add(importVat);
    offsetLines.push({
      glAccount: reconAccount,
      drCr: 'C',
      money: grossDoc,
      functionalAmount: isFx
        ? grossDoc.convert(fxRate!, functionalCurrency, this.registry)
        : undefined,
      partnerId: dto.vendorBpId,
    });

    // Resolve the determination accounts the journal needs (never hard-coded, §4.5). PRD always (any
    // line may be uncovered); realized FX only for a foreign cost invoice.
    const prdAccount = await this.accountDetermination.resolve({
      transactionKey: PRD_KEY,
      chartOfAccounts: company.chartOfAccounts,
      companyCode: company.code,
    });
    const realizedFxGainAccount = isFx
      ? await this.accountDetermination.resolve({
          transactionKey: REALIZED_FX_GAIN_KEY,
          chartOfAccounts: company.chartOfAccounts,
          companyCode: company.code,
        })
      : '';
    const realizedFxLossAccount = isFx
      ? await this.accountDetermination.resolve({
          transactionKey: REALIZED_FX_LOSS_KEY,
          chartOfAccounts: company.chartOfAccounts,
          companyCode: company.code,
        })
      : '';

    try {
      return await this.db.transaction(async (tx) => {
        const docNo = await this.numbering.next(NUMBER_OBJECT_LANDED_COST, 'GLOBAL', tx);
        const [header] = await tx
          .insert(schema.landedCost)
          .values({
            docType: DOC_TYPE_LANDED_COST,
            docNo,
            status: 'POSTED',
            postingKey: computedKey,
            companyCodeId: dto.companyCodeId,
            vendorBpId: dto.vendorBpId,
            purchaseOrderId: po.id,
            reference: dto.reference,
            importDeclarationNo: dto.importDeclarationNo ?? null,
            postingDate: dto.postingDate,
            documentDate: dto.documentDate,
            currency: docCurrency,
            exchangeRate,
            costAmount: costTotal.toNumeric(),
            importVatAmount: importVat.toNumeric(),
            vatTaxCode: dto.vatTaxCode ?? null,
            headerText: dto.headerText ?? null,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning({ id: schema.landedCost.id });
        if (!header) throw new Error('landed_cost insert returned no row');

        // Inventory writes material_valuation + posts the journal (single-writer), joining THIS tx.
        const result = await this.movements.revaluateValue(
          {
            landedCostId: header.id,
            docNo,
            sourceType: DOC_FLOW_TYPE_LANDED_COST,
            company: {
              companyCodeId: company.id,
              companyCode: company.code,
              chartOfAccounts: company.chartOfAccounts,
              currency: company.currency,
            },
            postingDate: dto.postingDate,
            documentDate: dto.documentDate,
            currency: docCurrency,
            fxRate,
            allocations,
            offsetLines,
            prdAccount,
            realizedFxGainAccount,
            realizedFxLossAccount,
            headerText: dto.headerText,
          },
          actor,
          tx,
        );

        await tx.insert(schema.landedCostItem).values(
          result.breakdown.map((b, i) => ({
            landedCostId: header.id,
            lineNo: i + 1,
            purchaseOrderItemId: b.purchaseOrderItemId,
            materialId: b.materialId,
            plantId: b.plantId,
            receivedFunctionalValue: b.receivedFunctionalValue,
            capitalizedShare: b.capitalizedShare,
            coveredShare: b.coveredShare,
            prdAmount: b.prdAmount,
            currency: functionalCurrency,
            createdBy: actor,
            updatedBy: actor,
          })),
        );

        // CAPITALIZES lineage: the landed_cost raised the value of each PO item (drill-down only).
        for (const a of allocations) {
          await this.docFlow.link(
            {
              sourceType: DOC_FLOW_TYPE_LANDED_COST,
              sourceId: header.id,
              targetType: DOC_FLOW_TYPE_PO_ITEM,
              targetId: a.purchaseOrderItemId,
              relType: REL_CAPITALIZES,
            },
            tx,
          );
        }

        const zero = Money.zero(functionalCurrency, this.registry);
        const totalCovered = result.breakdown.reduce(
          (s, b) => s.add(Money.fromNumeric(b.coveredShare, functionalCurrency, this.registry)),
          zero,
        );
        const totalPrd = result.breakdown.reduce(
          (s, b) => s.add(Money.fromNumeric(b.prdAmount, functionalCurrency, this.registry)),
          zero,
        );

        return {
          landedCostId: header.id,
          docNo,
          status: 'POSTED' as const,
          journalId: result.journalId,
          reconAccount,
          currency: docCurrency,
          costAmount: costTotal.toNumeric(),
          importVatAmount: importVat.toNumeric(),
          totalCovered: totalCovered.toNumeric(),
          totalPrd: totalPrd.toNumeric(),
        };
      });
    } catch (e) {
      // Concurrent duplicate post: the UNIQUE(company, posting_key) gate fired — replay the winner.
      if (isUniqueViolation(e, 'landed_cost_posting_key_uq')) {
        const winner = await this.findByKey(dto.companyCodeId, computedKey);
        if (winner) return this.toResult(winner, true);
      }
      throw e;
    }
  }

  /** Header + items (line order), or 404. `journalId` from the POSTS doc_flow edge. */
  async getLandedCost(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.landedCost)
      .where(eq(schema.landedCost.id, id));
    if (!header) throw new NotFoundException(`landed cost ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.landedCostItem)
      .where(eq(schema.landedCostItem.landedCostId, id))
      .orderBy(asc(schema.landedCostItem.lineNo));
    return { ...header, items, journalId: await this.journalIdOf(id) };
  }

  /** A PO's landed-cost documents (drill-down), in doc order. */
  async listForPurchaseOrder(purchaseOrderId: string) {
    return this.db
      .select()
      .from(schema.landedCost)
      .where(eq(schema.landedCost.purchaseOrderId, purchaseOrderId))
      .orderBy(asc(schema.landedCost.docNo));
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

  /** Resolve the INPUT import-VAT code → its 부가세대급금 GL (supplied amount; never net×rate). */
  private async resolveImportVatAccount(code: string): Promise<string> {
    const [tc] = await this.db.select().from(schema.taxCode).where(eq(schema.taxCode.code, code));
    if (!tc) throw new BadRequestException(`tax code ${code} not found`);
    if (tc.kind !== 'INPUT') {
      throw new BadRequestException(`tax code ${code} is ${tc.kind}; import VAT needs an INPUT code`);
    }
    if (!tc.glAccount) {
      throw new BadRequestException(`tax code ${code} has no VAT GL account configured`);
    }
    return tc.glAccount;
  }

  private async journalIdOf(landedCostId: string): Promise<string | null> {
    const edges = await this.docFlow.forward(DOC_FLOW_TYPE_LANDED_COST, landedCostId);
    return edges.find((e) => e.relType === REL_POSTS)?.targetId ?? null;
  }

  private async findByKey(companyCodeId: string, postingKey: string) {
    const [row] = await this.db
      .select()
      .from(schema.landedCost)
      .where(
        and(
          eq(schema.landedCost.companyCodeId, companyCodeId),
          eq(schema.landedCost.postingKey, postingKey),
        ),
      );
    return row;
  }

  /** Reconstruct the response from a stored landed cost (idempotent replay). */
  private async toResult(
    row: typeof schema.landedCost.$inferSelect,
    replayed = false,
  ): Promise<PostedLandedCost> {
    // The capitalized amounts are functional (KRW); the row currency is the document currency (equal
    // to the functional currency for a domestic cost invoice). Use the company functional currency.
    const company = await this.getCompany(row.companyCodeId);
    const funcCcy = company.currency as CurrencyCode;
    const zero = Money.zero(funcCcy, this.registry);

    const items = await this.db
      .select({
        coveredShare: schema.landedCostItem.coveredShare,
        prdAmount: schema.landedCostItem.prdAmount,
      })
      .from(schema.landedCostItem)
      .where(eq(schema.landedCostItem.landedCostId, row.id));
    const totalCovered = items.reduce(
      (s, it) => s.add(Money.fromNumeric(it.coveredShare, funcCcy, this.registry)),
      zero,
    );
    const totalPrd = items.reduce(
      (s, it) => s.add(Money.fromNumeric(it.prdAmount, funcCcy, this.registry)),
      zero,
    );

    const bp = await this.partners.getBp(row.vendorBpId);

    return {
      landedCostId: row.id,
      docNo: row.docNo,
      status: 'POSTED',
      journalId: (await this.journalIdOf(row.id)) ?? '',
      reconAccount: bp.vendor?.apReconAccount ?? '',
      currency: row.currency,
      costAmount: row.costAmount,
      importVatAmount: row.importVatAmount,
      totalCovered: totalCovered.toNumeric(),
      totalPrd: totalPrd.toNumeric(),
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
