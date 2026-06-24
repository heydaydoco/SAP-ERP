import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { BusinessPartnerService } from '../../master-data/business-partner/business-partner.service.js';
import { CurrencyService } from '../../master-data/currency/currency.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import {
  DOC_FLOW_TYPE_DELIVERY,
  DOC_FLOW_TYPE_EXPORT_DECLARATION,
  DOC_TYPE_EXPORT_DECLARATION,
  NUMBER_OBJECT_EXPORT_DECLARATION,
  REL_DECLARES,
} from '../trade-compliance.constants.js';
import { sumFobAmounts } from './export-declaration-calc.js';
import {
  exportDeclarationWarnings,
  type BillingTaxState,
  type ExportDeclarationWarning,
} from './export-declaration-warnings.js';
import type {
  AcceptExportDeclarationDto,
  CreateExportDeclarationDto,
  ExportDeclarationQuery,
} from './export-declaration.dto.js';

/**
 * Export-declaration service (trade-compliance.export-declaration = 수출신고). Creates the customs filing
 * for an exported delivery: header + line items (material / HS / 수량 / FOB). **Posts NOTHING to FI** — a
 * Korean export is 영세율 (value already moved at SD billing); the only linkage is a doc_flow `DECLARES`
 * edge onto the delivery's 601 GI (`inventory.goods_movement`). Lifecycle: create (SUBMITTED) → accept
 * (수리 → ACCEPTED, stamping the externally-issued 수출신고번호/MRN).
 *
 * Cross-domain reads are READ-ONLY (delivery / sales_order for the physical anchor + company check;
 * billing / billing_item for the 영세율 gate) — never a write into another domain's tables/services.
 */
@Injectable()
export class ExportDeclarationService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly partners: BusinessPartnerService,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
    private readonly currencies: CurrencyService,
    private readonly registry: DbCurrencyRegistry,
  ) {}

  async create(dto: CreateExportDeclarationDto, actor = 'system') {
    const company = await this.getCompany(dto.companyCodeId);

    // Export declarations may be FOREIGN-currency; the currency only has to exist in the master. A typo
    // fails here at filing, not later.
    if (dto.currency !== company.currency) {
      const [cur] = await this.db
        .select({ code: schema.currency.code })
        .from(schema.currency)
        .where(eq(schema.currency.code, dto.currency));
      if (!cur) {
        throw new BadRequestException(
          `export declaration currency ${dto.currency} is not defined in the currency master`,
        );
      }
    }

    const bp = await this.partners.getBp(dto.customerBpId);
    if (!bp.customer) {
      throw new BadRequestException(`business partner ${dto.customerBpId} has no customer role`);
    }
    // The broker (관세사) is optional; if named it must exist (getBp 404s otherwise).
    if (dto.brokerBpId) await this.partners.getBp(dto.brokerBpId);

    // Resolve the source delivery (read-only): the 601 GI for the DECLARES edge, the SO for the G2 gate
    // and the company-match check.
    const delivery = await this.resolveDelivery(dto.sourceDeliveryId, dto.companyCodeId);

    // Validate every material exists; snapshot HS / origin from material_trade when the DTO omits them.
    const snapshots = await this.resolveItemSnapshots(dto);

    // FX stamp for a foreign declaration (audit/reporting only — nothing posts). Resolved on the
    // declaration date, exactly like billing/landed-cost.
    let exchangeRate: string | null = null;
    if (dto.currency !== company.currency) {
      const resolved = await this.currencies.resolveRate(
        dto.currency,
        company.currency,
        dto.declarationDate,
        'M',
      );
      exchangeRate = resolved.rate;
    }

    // Total FOB through Money (exact per-currency minor units; a finer line amount → 400).
    let totalFob: string;
    try {
      totalFob = sumFobAmounts(
        dto.items.map((it, i) => ({ lineNo: i + 1, fobAmount: it.fobAmount })),
        dto.currency,
        this.registry,
      );
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    // G2 (read-only): the declared delivery's downstream billing tax state.
    const billing = await this.resolveBillingTaxState(delivery.salesOrderId);

    // SOFT, non-blocking warnings (G0 trade_direction / G1 HS / G2 영세율) — create proceeds regardless.
    const warnings: ExportDeclarationWarning[] = exportDeclarationWarnings({
      tradeDirection: dto.tradeDirection ?? 'EXP',
      items: dto.items.map((it, i) => ({
        lineNo: i + 1,
        hasHsCode: Boolean(it.hsCode ?? snapshots.get(it.materialId)?.hsCode),
      })),
      billing,
    });

    const result = await this.db.transaction(async (tx) => {
      const docNo = await this.numbering.next(NUMBER_OBJECT_EXPORT_DECLARATION, 'GLOBAL', tx);
      const [header] = await tx
        .insert(schema.exportDeclaration)
        .values({
          docType: DOC_TYPE_EXPORT_DECLARATION,
          docNo,
          status: 'SUBMITTED',
          companyCodeId: dto.companyCodeId,
          customerBpId: dto.customerBpId,
          brokerBpId: dto.brokerBpId ?? null,
          declarationNo: dto.declarationNo ?? null,
          declarationDate: dto.declarationDate,
          incoterm: dto.incoterm ?? null,
          // EXP by default — it is an export declaration (a non-EXP override only soft-warns).
          tradeDirection: dto.tradeDirection ?? 'EXP',
          shipToCountry: dto.shipToCountry ?? null,
          customsOffice: dto.customsOffice ?? null,
          currency: dto.currency,
          exchangeRate,
          totalFobAmount: totalFob,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning({ id: schema.exportDeclaration.id });
      if (!header) throw new Error('export_declaration insert returned no row');

      await tx.insert(schema.exportDeclarationItem).values(
        dto.items.map((it, i) => ({
          declarationId: header.id,
          lineNo: i + 1,
          materialId: it.materialId,
          hsCode: it.hsCode ?? snapshots.get(it.materialId)?.hsCode ?? null,
          originCountry: it.originCountry ?? snapshots.get(it.materialId)?.origin ?? null,
          qty: it.qty,
          uom: it.uom,
          fobAmount: it.fobAmount,
          currency: dto.currency,
          netWeight: it.netWeight ?? null,
          createdBy: actor,
          updatedBy: actor,
        })),
      );

      // Physical lineage (§4.3): the declaration DECLARES the delivery's 601 GI. PLAIN string target (the
      // doc_flow graph is generic) — never a journal (the declaration posts nothing).
      await this.docFlow.link(
        {
          sourceType: DOC_FLOW_TYPE_EXPORT_DECLARATION,
          sourceId: header.id,
          targetType: DOC_FLOW_TYPE_DELIVERY,
          targetId: delivery.goodsMovementId,
          relType: REL_DECLARES,
        },
        tx,
      );

      return { exportDeclarationId: header.id, docNo, status: 'SUBMITTED' as const };
    });

    return { ...result, warnings };
  }

  /** 수리: stamp the externally-issued 수출신고번호 (MRN) + 신고수리일 and flip SUBMITTED → ACCEPTED. */
  async accept(id: string, dto: AcceptExportDeclarationDto, actor = 'system') {
    // Atomic transition guard: only a still-SUBMITTED row flips, so two concurrent 수리 calls cannot both
    // stamp the MRN (the second updates zero rows and 409s).
    const [updated] = await this.db
      .update(schema.exportDeclaration)
      .set({
        status: 'ACCEPTED',
        declarationNo: dto.declarationNo,
        // ADDITIVE: stamp the 신고수리일 (drives duty-drawback). The MRN stamp + status flip are unchanged.
        acceptanceDate: dto.acceptanceDate ?? null,
        updatedBy: actor,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.exportDeclaration.id, id),
          eq(schema.exportDeclaration.status, 'SUBMITTED'),
        ),
      )
      .returning();
    if (updated) return updated;
    // No row transitioned — distinguish not-found from wrong-status for a precise error.
    const [existing] = await this.db
      .select({ status: schema.exportDeclaration.status })
      .from(schema.exportDeclaration)
      .where(eq(schema.exportDeclaration.id, id));
    if (!existing) throw new NotFoundException(`export declaration ${id} not found`);
    throw new ConflictException(
      `export declaration ${id} is ${existing.status}; only a SUBMITTED declaration can be accepted`,
    );
  }

  /** Header + items (line order) + outward lineage edges, or 404. */
  async getExportDeclaration(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.exportDeclaration)
      .where(eq(schema.exportDeclaration.id, id));
    if (!header) throw new NotFoundException(`export declaration ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.exportDeclarationItem)
      .where(eq(schema.exportDeclarationItem.declarationId, id))
      .orderBy(asc(schema.exportDeclarationItem.lineNo));
    const lineage = await this.docFlow.forward(DOC_FLOW_TYPE_EXPORT_DECLARATION, id);
    return { ...header, items, lineage };
  }

  async listExportDeclarations(q: ExportDeclarationQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.exportDeclaration)
      .where(this.listWhere(q))
      .orderBy(desc(schema.exportDeclaration.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countExportDeclarations(q: ExportDeclarationQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.exportDeclaration)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: ExportDeclarationQuery) {
    return and(
      q.companyCodeId ? eq(schema.exportDeclaration.companyCodeId, q.companyCodeId) : undefined,
      q.customerBpId ? eq(schema.exportDeclaration.customerBpId, q.customerBpId) : undefined,
      q.status ? eq(schema.exportDeclaration.status, q.status) : undefined,
      q.declarationNo ? eq(schema.exportDeclaration.declarationNo, q.declarationNo) : undefined,
    );
  }

  private async getCompany(companyCodeId: string) {
    const [company] = await this.db
      .select()
      .from(schema.companyCode)
      .where(eq(schema.companyCode.id, companyCodeId));
    if (!company) throw new NotFoundException(`company code ${companyCodeId} not found`);
    return company;
  }

  /**
   * Resolve the source delivery (read-only): returns its 601 GI id (the DECLARES target) and SO id (the
   * G2 source). A delivery carries no company column, so the company-match check rides its SO.
   */
  private async resolveDelivery(deliveryId: string, companyCodeId: string) {
    const [d] = await this.db
      .select({
        id: schema.delivery.id,
        salesOrderId: schema.delivery.salesOrderId,
        goodsMovementId: schema.delivery.goodsMovementId,
      })
      .from(schema.delivery)
      .where(eq(schema.delivery.id, deliveryId));
    if (!d) throw new NotFoundException(`delivery ${deliveryId} not found`);
    const [so] = await this.db
      .select({ companyCodeId: schema.salesOrder.companyCodeId })
      .from(schema.salesOrder)
      .where(eq(schema.salesOrder.id, d.salesOrderId));
    if (!so) {
      throw new NotFoundException(`sales order ${d.salesOrderId} for delivery ${deliveryId} not found`);
    }
    if (so.companyCodeId !== companyCodeId) {
      throw new BadRequestException(`delivery ${deliveryId} belongs to another company code`);
    }
    return d;
  }

  /** Validate each material; map materialId → its `material_trade` HS / origin snapshot (when present). */
  private async resolveItemSnapshots(
    dto: CreateExportDeclarationDto,
  ): Promise<Map<string, { hsCode: string; origin: string | null }>> {
    const materialIds = [...new Set(dto.items.map((i) => i.materialId))];
    const materials = await this.db
      .select({ id: schema.material.id })
      .from(schema.material)
      .where(inArray(schema.material.id, materialIds));
    const known = new Set(materials.map((m) => m.id));
    for (const id of materialIds) {
      if (!known.has(id)) throw new NotFoundException(`material ${id} not found`);
    }
    const trades = await this.db
      .select({
        materialId: schema.materialTrade.materialId,
        hsCode: schema.materialTrade.hsCode,
        origin: schema.materialTrade.countryOfOrigin,
      })
      .from(schema.materialTrade)
      .where(inArray(schema.materialTrade.materialId, materialIds));
    return new Map(trades.map((t) => [t.materialId, { hsCode: t.hsCode, origin: t.origin }]));
  }

  /**
   * READ-ONLY downstream-billing tax state for the declared delivery's SO (the G2 gate input). Mirrors
   * the doc_flow GI→SO←billing relationship via the canonical FKs (billing.sales_order_id). Returns NONE
   * when no billing exists yet; otherwise each billing line's tax_code with its resolved master rate
   * (NULL tax_code → null rate).
   */
  private async resolveBillingTaxState(salesOrderId: string): Promise<BillingTaxState> {
    const billings = await this.db
      .select({ id: schema.billing.id })
      .from(schema.billing)
      .where(eq(schema.billing.salesOrderId, salesOrderId));
    if (billings.length === 0) return { kind: 'NONE' };

    const items = await this.db
      .select({ taxCode: schema.billingItem.taxCode })
      .from(schema.billingItem)
      .where(
        inArray(
          schema.billingItem.billingId,
          billings.map((b) => b.id),
        ),
      );

    const codes = [...new Set(items.map((i) => i.taxCode).filter((c): c is string => !!c))];
    const rateByCode = new Map<string, string>();
    if (codes.length > 0) {
      const taxRows = await this.db
        .select({ code: schema.taxCode.code, ratePercent: schema.taxCode.ratePercent })
        .from(schema.taxCode)
        .where(inArray(schema.taxCode.code, codes));
      for (const t of taxRows) rateByCode.set(t.code, t.ratePercent);
    }

    return {
      kind: 'EXISTS',
      lines: items.map((i) => ({
        taxCode: i.taxCode,
        ratePercent: i.taxCode ? (rateByCode.get(i.taxCode) ?? null) : null,
      })),
    };
  }
}
