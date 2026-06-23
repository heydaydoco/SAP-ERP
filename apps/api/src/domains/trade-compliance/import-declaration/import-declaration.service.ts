import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '@erp/kernel';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { BusinessPartnerService } from '../../master-data/business-partner/business-partner.service.js';
import { CurrencyService } from '../../master-data/currency/currency.service.js';
import { DbCurrencyRegistry } from '../../master-data/currency/db-currency-registry.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import {
  DOC_FLOW_TYPE_GOODS_RECEIPT,
  DOC_FLOW_TYPE_IMPORT_DECLARATION,
  DOC_TYPE_IMPORT_DECLARATION,
  GR_MOVEMENT_TYPE,
  NUMBER_OBJECT_IMPORT_DECLARATION,
  REL_DECLARES,
} from '../trade-compliance.constants.js';
import {
  amountsMatch,
  dutyWithinTolerance,
  expectedDutyAmount,
  sumCustomsValues,
} from './import-declaration-calc.js';
import {
  importDeclarationWarnings,
  type ImportDeclarationWarning,
} from './import-declaration-warnings.js';
import type {
  AcceptImportDeclarationDto,
  CreateImportDeclarationDto,
  ImportDeclarationQuery,
} from './import-declaration.dto.js';

/**
 * Import-declaration service (trade-compliance.import-declaration = 수입신고). Files the customs declaration
 * for a received import GR: header + line items (material / HS / 원산지 / 수량 / 과세가격 / 관세율). **Posts
 * NOTHING to FI** — import accounting (관세 + 수입부가세 재고원가 배부) is the LANDED-COST document's sole job,
 * already booked at/after the GR; a posting here would double-count. So `customs_value` / `duty_amount` /
 * `import_vat_amount` are legal RECORD fields, and the only linkage is a doc_flow `DECLARES` edge onto the
 * same 수입 GR (101 `inventory.goods_movement`) — the symmetry of export's `DECLARES`→601 GI. Lifecycle:
 * create (SUBMITTED) → accept (수리 → ACCEPTED, stamping the externally-issued 수입신고번호/MRN + 신고수리일).
 *
 * Cross-domain reads are READ-ONLY (goods_movement / plant for the GR anchor + company check; material_trade
 * for the HS/origin snapshot) — never a write into another domain's tables/services, and landed cost is
 * never touched.
 */
@Injectable()
export class ImportDeclarationService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly partners: BusinessPartnerService,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
    private readonly currencies: CurrencyService,
    private readonly registry: DbCurrencyRegistry,
  ) {}

  async create(dto: CreateImportDeclarationDto, actor = 'system') {
    const company = await this.getCompany(dto.companyCodeId);

    // Import declarations may be FOREIGN-currency; the currency only has to exist in the master.
    if (dto.currency !== company.currency) {
      const [cur] = await this.db
        .select({ code: schema.currency.code })
        .from(schema.currency)
        .where(eq(schema.currency.code, dto.currency));
      if (!cur) {
        throw new BadRequestException(
          `import declaration currency ${dto.currency} is not defined in the currency master`,
        );
      }
    }

    const bp = await this.partners.getBp(dto.supplierBpId);
    if (!bp.vendor) {
      throw new BadRequestException(`business partner ${dto.supplierBpId} has no vendor role`);
    }
    // The broker (관세사) is optional; if named it must exist (getBp 404s otherwise).
    if (dto.brokerBpId) await this.partners.getBp(dto.brokerBpId);

    // Resolve the source 수입 GR (read-only): the 101 goods_movement that anchors the DECLARES edge + the
    // company-match check, plus its line ids (to validate any source_gr_item_ref).
    const gr = await this.resolveGoodsReceipt(dto.sourceGoodsMovementId, dto.companyCodeId);
    dto.items.forEach((it, i) => {
      if (it.sourceGrItemRef && !gr.itemIds.has(it.sourceGrItemRef)) {
        throw new BadRequestException(
          `line ${i + 1}: source_gr_item_ref ${it.sourceGrItemRef} is not a line of goods receipt ${gr.id}`,
        );
      }
    });

    // Validate every material exists; snapshot HS / origin from material_trade when the DTO omits them.
    const snapshots = await this.resolveItemSnapshots(dto);

    // FX stamp for a foreign declaration (audit/reporting only — nothing posts). Resolved on the
    // declaration date, exactly like billing/landed-cost/export.
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

    // Validate + normalize the declared header amounts through Money (exact per-currency minor units; a
    // finer value than the currency allows → 400). These are RECORD fields — no journal touches them.
    const norm = (amount: string, label: string): string => {
      try {
        return Money.of(amount, dto.currency, this.registry).toNumeric();
      } catch (err) {
        throw new BadRequestException(`${label}: ${(err as Error).message}`);
      }
    };
    const customsValue = norm(dto.customsValue, 'customs_value');
    const dutyAmount = norm(dto.dutyAmount, 'duty_amount');
    const importVatAmount = norm(dto.importVatAmount, 'import_vat_amount');

    // G3a basis: the Money-exact line 과세가격 sum (rejects an over-precision line → 400).
    let lineSum: string;
    try {
      lineSum = sumCustomsValues(
        dto.items.map((it, i) => ({ lineNo: i + 1, customsValue: it.customsValue })),
        dto.currency,
        this.registry,
      );
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    // G3b basis: the duty estimate (null when not every line declares a rate → G3b skipped).
    const expected = expectedDutyAmount(
      dto.items.map((it) => ({ customsValue: it.customsValue, dutyRate: it.dutyRate ?? null })),
      dto.currency,
      this.registry,
    );
    const duty =
      expected == null
        ? null
        : {
            declared: dutyAmount,
            expected,
            withinTolerance: dutyWithinTolerance(dutyAmount, expected, dto.currency, this.registry),
          };

    // SOFT, non-blocking warnings (G0 trade_direction / G1 HS / G2 원산지 / G3 과세가격·관세액) — create
    // proceeds regardless.
    const warnings: ImportDeclarationWarning[] = importDeclarationWarnings({
      tradeDirection: dto.tradeDirection ?? 'IMP',
      items: dto.items.map((it, i) => ({
        lineNo: i + 1,
        hasHsCode: Boolean(it.hsCode ?? snapshots.get(it.materialId)?.hsCode),
        hasOrigin: Boolean(it.originCountry ?? snapshots.get(it.materialId)?.origin),
      })),
      customsValue: { headerDeclared: customsValue, lineSum, matches: amountsMatch(customsValue, lineSum, dto.currency, this.registry) },
      duty,
    });

    const result = await this.db.transaction(async (tx) => {
      const docNo = await this.numbering.next(NUMBER_OBJECT_IMPORT_DECLARATION, 'GLOBAL', tx);
      const [header] = await tx
        .insert(schema.importDeclaration)
        .values({
          docType: DOC_TYPE_IMPORT_DECLARATION,
          docNo,
          status: 'SUBMITTED',
          companyCodeId: dto.companyCodeId,
          supplierBpId: dto.supplierBpId,
          brokerBpId: dto.brokerBpId ?? null,
          sourceGoodsMovementId: gr.id,
          declarationNo: dto.declarationNo ?? null,
          declarationDate: dto.declarationDate,
          acceptanceDate: null,
          incoterm: dto.incoterm ?? null,
          // IMP by default — it is an import declaration (a non-IMP override only soft-warns).
          tradeDirection: dto.tradeDirection ?? 'IMP',
          originCountry: dto.originCountry ?? null,
          customsOffice: dto.customsOffice ?? null,
          currency: dto.currency,
          exchangeRate,
          customsValue,
          dutyAmount,
          importVatAmount,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning({ id: schema.importDeclaration.id });
      if (!header) throw new Error('import_declaration insert returned no row');

      await tx.insert(schema.importDeclarationItem).values(
        dto.items.map((it, i) => ({
          declarationId: header.id,
          lineNo: i + 1,
          sourceGrItemRef: it.sourceGrItemRef ?? null,
          materialId: it.materialId,
          hsCode: it.hsCode ?? snapshots.get(it.materialId)?.hsCode ?? null,
          originCountry: it.originCountry ?? snapshots.get(it.materialId)?.origin ?? null,
          qty: it.qty,
          uom: it.uom,
          // Money-canonical NUMERIC(18,4) (already validated by sumCustomsValues above), so line and
          // header customs values are stored uniformly Money-derived, not relying on the column scale.
          customsValue: Money.of(it.customsValue, dto.currency, this.registry).toNumeric(),
          dutyRate: it.dutyRate ?? null,
          currency: dto.currency,
          createdBy: actor,
          updatedBy: actor,
        })),
      );

      // Physical lineage (§4.3): the declaration DECLARES the 수입 GR (101 receipt). PLAIN string target (the
      // doc_flow graph is generic) — never a journal (the declaration posts nothing; landed cost owns the FI).
      await this.docFlow.link(
        {
          sourceType: DOC_FLOW_TYPE_IMPORT_DECLARATION,
          sourceId: header.id,
          targetType: DOC_FLOW_TYPE_GOODS_RECEIPT,
          targetId: gr.id,
          relType: REL_DECLARES,
        },
        tx,
      );

      return { importDeclarationId: header.id, docNo, status: 'SUBMITTED' as const };
    });

    return { ...result, warnings };
  }

  /** 수리: stamp the externally-issued 수입신고번호 (MRN) + 신고수리일 and flip SUBMITTED → ACCEPTED. */
  async accept(id: string, dto: AcceptImportDeclarationDto, actor = 'system') {
    // Atomic transition guard: only a still-SUBMITTED row flips, so two concurrent 수리 calls cannot both
    // stamp the MRN (the second updates zero rows and 409s).
    const [updated] = await this.db
      .update(schema.importDeclaration)
      .set({
        status: 'ACCEPTED',
        declarationNo: dto.declarationNo,
        acceptanceDate: dto.acceptanceDate ?? null,
        updatedBy: actor,
        updatedAt: new Date(),
      })
      .where(
        and(eq(schema.importDeclaration.id, id), eq(schema.importDeclaration.status, 'SUBMITTED')),
      )
      .returning();
    if (updated) return updated;
    // No row transitioned — distinguish not-found from wrong-status for a precise error.
    const [existing] = await this.db
      .select({ status: schema.importDeclaration.status })
      .from(schema.importDeclaration)
      .where(eq(schema.importDeclaration.id, id));
    if (!existing) throw new NotFoundException(`import declaration ${id} not found`);
    throw new ConflictException(
      `import declaration ${id} is ${existing.status}; only a SUBMITTED declaration can be accepted`,
    );
  }

  /** Header + items (line order) + outward lineage edges, or 404. */
  async getImportDeclaration(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.importDeclaration)
      .where(eq(schema.importDeclaration.id, id));
    if (!header) throw new NotFoundException(`import declaration ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.importDeclarationItem)
      .where(eq(schema.importDeclarationItem.declarationId, id))
      .orderBy(asc(schema.importDeclarationItem.lineNo));
    const lineage = await this.docFlow.forward(DOC_FLOW_TYPE_IMPORT_DECLARATION, id);
    return { ...header, items, lineage };
  }

  async listImportDeclarations(q: ImportDeclarationQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.importDeclaration)
      .where(this.listWhere(q))
      .orderBy(desc(schema.importDeclaration.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countImportDeclarations(q: ImportDeclarationQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.importDeclaration)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: ImportDeclarationQuery) {
    return and(
      q.companyCodeId ? eq(schema.importDeclaration.companyCodeId, q.companyCodeId) : undefined,
      q.supplierBpId ? eq(schema.importDeclaration.supplierBpId, q.supplierBpId) : undefined,
      q.status ? eq(schema.importDeclaration.status, q.status) : undefined,
      q.declarationNo ? eq(schema.importDeclaration.declarationNo, q.declarationNo) : undefined,
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
   * Resolve the source 수입 GR (read-only): it must exist, be a 101 receipt, and belong to the company (via
   * its plant). Returns the GR id (the DECLARES target) and its line ids (to validate source_gr_item_ref).
   */
  private async resolveGoodsReceipt(
    goodsMovementId: string,
    companyCodeId: string,
  ): Promise<{ id: string; itemIds: Set<string> }> {
    const [gm] = await this.db
      .select({
        id: schema.goodsMovement.id,
        movementType: schema.goodsMovement.movementType,
        plantId: schema.goodsMovement.plantId,
      })
      .from(schema.goodsMovement)
      .where(eq(schema.goodsMovement.id, goodsMovementId));
    if (!gm) throw new NotFoundException(`goods receipt ${goodsMovementId} not found`);
    if (gm.movementType !== GR_MOVEMENT_TYPE) {
      throw new BadRequestException(
        `goods movement ${goodsMovementId} is not a 수입 GR (movement_type ${gm.movementType}, expected ${GR_MOVEMENT_TYPE})`,
      );
    }
    const [plant] = await this.db
      .select({ companyCodeId: schema.plant.companyCodeId })
      .from(schema.plant)
      .where(eq(schema.plant.id, gm.plantId));
    if (!plant) {
      throw new NotFoundException(
        `plant ${gm.plantId} for goods receipt ${goodsMovementId} not found`,
      );
    }
    if (plant.companyCodeId !== companyCodeId) {
      throw new BadRequestException(`goods receipt ${goodsMovementId} belongs to another company code`);
    }
    const items = await this.db
      .select({ id: schema.goodsMovementItem.id })
      .from(schema.goodsMovementItem)
      .where(eq(schema.goodsMovementItem.goodsMovementId, goodsMovementId));
    return { id: gm.id, itemIds: new Set(items.map((r) => r.id)) };
  }

  /** Validate each material; map materialId → its `material_trade` HS / origin snapshot (when present). */
  private async resolveItemSnapshots(
    dto: CreateImportDeclarationDto,
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
}
