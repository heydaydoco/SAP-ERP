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
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { DOC_TYPE_SALES_ORDER, NUMBER_OBJECT_SO } from '../sales.constants.js';
import { exportTaxWarnings, type TradeWarningLine } from './trade-warnings.js';
import type { CreateSalesOrderDto, SalesOrderQuery } from './sales-order.dto.js';

/**
 * Sales-order service (sales.sales-order) — the MIRROR of `PurchaseOrderService` on the O2C side.
 * Creates the selling commitment: customer, ordered quantities, agreed SALES prices. No FI posting
 * (value moves at delivery/GI → COGS, and billing → AR). A SO may be FOREIGN-currency (export); the
 * currency only has to exist in the master (billing resolves the rate per invoice).
 *
 * Line tax codes are resolved + validated as OUTPUT VAT at creation (fail fast), and an EXPORT order
 * carrying a TAXABLE code raises a SOFT warning (§5) — `trade_direction` is stored only and never picks
 * the rate, so DOM + V00 (영세율 내국신용장) passes clean and is never blocked.
 */
@Injectable()
export class SalesOrderService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly partners: BusinessPartnerService,
    private readonly numbering: NumberingService,
  ) {}

  async create(dto: CreateSalesOrderDto, actor = 'system') {
    const company = await this.getCompany(dto.companyCodeId);
    // Export SOs may be FOREIGN-currency; the currency only has to exist in the master (billing resolves
    // the document-date rate). A typo fails here at creation, not at the first billing.
    if (dto.currency !== company.currency) {
      const [cur] = await this.db
        .select({ code: schema.currency.code })
        .from(schema.currency)
        .where(eq(schema.currency.code, dto.currency));
      if (!cur) {
        throw new BadRequestException(
          `sales order currency ${dto.currency} is not defined in the currency master`,
        );
      }
    }

    const bp = await this.partners.getBp(dto.customerBpId);
    if (!bp.customer) {
      throw new BadRequestException(`business partner ${dto.customerBpId} has no customer role`);
    }
    if (bp.customer.salesBlock) {
      throw new ConflictException(`customer ${dto.customerBpId} is blocked for sales`);
    }

    if (dto.salesOrgId) {
      const [org] = await this.db
        .select({ companyCodeId: schema.salesOrg.companyCodeId })
        .from(schema.salesOrg)
        .where(eq(schema.salesOrg.id, dto.salesOrgId));
      if (!org) throw new NotFoundException(`sales org ${dto.salesOrgId} not found`);
      if (org.companyCodeId !== dto.companyCodeId) {
        throw new BadRequestException('sales org belongs to another company code');
      }
    }

    await this.validateItems(dto);

    // Resolve + validate each line's OUTPUT VAT code, then collect the EXPORT-contradiction soft warning.
    const rates = await this.resolveOutputTaxRates(dto);
    const warningLines: TradeWarningLine[] = dto.items.map((item, i) => ({
      lineNo: i + 1,
      taxCode: item.taxCode ?? null,
      ratePercent: item.taxCode ? (rates.get(item.taxCode) ?? null) : null,
    }));
    const warnings = exportTaxWarnings(dto.tradeDirection, warningLines);

    const result = await this.db.transaction(async (tx) => {
      const docNo = await this.numbering.next(NUMBER_OBJECT_SO, 'GLOBAL', tx);
      const [header] = await tx
        .insert(schema.salesOrder)
        .values({
          docType: DOC_TYPE_SALES_ORDER,
          docNo,
          status: 'ORDERED',
          companyCodeId: dto.companyCodeId,
          customerBpId: dto.customerBpId,
          salesOrgId: dto.salesOrgId ?? null,
          currency: dto.currency,
          orderDate: dto.orderDate,
          incoterm: dto.incoterm ?? null,
          tradeDirection: dto.tradeDirection ?? null,
          shipToCountry: dto.shipToCountry ?? null,
          zeroRateDocNo: dto.zeroRateDocNo ?? null,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning({ id: schema.salesOrder.id });
      if (!header) throw new Error('sales_order insert returned no row');

      await tx.insert(schema.salesOrderItem).values(
        dto.items.map((item, i) => ({
          salesOrderId: header.id,
          lineNo: i + 1,
          materialId: item.materialId,
          plantId: item.plantId,
          storageLocationId: item.storageLocationId,
          orderedQty: item.orderedQty,
          unitPrice: item.unitPrice,
          currency: dto.currency,
          taxCode: item.taxCode ?? null,
          createdBy: actor,
          updatedBy: actor,
        })),
      );

      return { salesOrderId: header.id, docNo, status: 'ORDERED' as const };
    });

    return { ...result, warnings };
  }

  /** Header + items (line order), or 404. */
  async getSalesOrder(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.salesOrder)
      .where(eq(schema.salesOrder.id, id));
    if (!header) throw new NotFoundException(`sales order ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.salesOrderItem)
      .where(eq(schema.salesOrderItem.salesOrderId, id))
      .orderBy(asc(schema.salesOrderItem.lineNo));
    return { ...header, items };
  }

  async listSalesOrders(q: SalesOrderQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.salesOrder)
      .where(this.listWhere(q))
      .orderBy(desc(schema.salesOrder.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countSalesOrders(q: SalesOrderQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.salesOrder)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: SalesOrderQuery) {
    return and(
      q.companyCodeId ? eq(schema.salesOrder.companyCodeId, q.companyCodeId) : undefined,
      q.customerBpId ? eq(schema.salesOrder.customerBpId, q.customerBpId) : undefined,
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

  /** Validate every item's material exists and its storage location belongs to the named plant. */
  private async validateItems(dto: CreateSalesOrderDto): Promise<void> {
    const materialIds = [...new Set(dto.items.map((i) => i.materialId))];
    const materials = await this.db
      .select({ id: schema.material.id })
      .from(schema.material)
      .where(inArray(schema.material.id, materialIds));
    const knownMaterials = new Set(materials.map((m) => m.id));
    for (const id of materialIds) {
      if (!knownMaterials.has(id)) throw new NotFoundException(`material ${id} not found`);
    }

    const slocIds = [...new Set(dto.items.map((i) => i.storageLocationId))];
    const slocs = await this.db
      .select({ id: schema.storageLocation.id, plantId: schema.storageLocation.plantId })
      .from(schema.storageLocation)
      .where(inArray(schema.storageLocation.id, slocIds));
    const slocPlant = new Map(slocs.map((s) => [s.id, s.plantId]));
    for (const item of dto.items) {
      const plantId = slocPlant.get(item.storageLocationId);
      if (plantId === undefined) {
        throw new NotFoundException(`storage location ${item.storageLocationId} not found`);
      }
      if (plantId !== item.plantId) {
        throw new BadRequestException(
          `storage location ${item.storageLocationId} does not belong to plant ${item.plantId}`,
        );
      }
    }
  }

  /**
   * Resolve each referenced tax code → its rate (percentage points), asserting it exists, is OUTPUT VAT
   * (a sales line), and has a VAT GL account (so billing can post it). Returns code → ratePercent.
   */
  private async resolveOutputTaxRates(dto: CreateSalesOrderDto): Promise<Map<string, string>> {
    const codes = [...new Set(dto.items.map((i) => i.taxCode).filter((c): c is string => !!c))];
    const rates = new Map<string, string>();
    for (const code of codes) {
      const [tc] = await this.db.select().from(schema.taxCode).where(eq(schema.taxCode.code, code));
      if (!tc) throw new BadRequestException(`tax code ${code} not found`);
      if (tc.kind !== 'OUTPUT') {
        throw new BadRequestException(
          `tax code ${code} is ${tc.kind}; a sales order line needs OUTPUT VAT`,
        );
      }
      if (!tc.glAccount) {
        throw new BadRequestException(`tax code ${code} has no VAT GL account configured`);
      }
      rates.set(code, tc.ratePercent);
    }
    return rates;
  }
}
