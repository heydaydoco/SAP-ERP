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
import { DOC_TYPE_PURCHASE_ORDER, NUMBER_OBJECT_PO } from '../procurement.constants.js';
import type { CreatePurchaseOrderDto, PurchaseOrderQuery } from './purchase-order.dto.js';

/**
 * Purchase-order service (procurement.purchase-order). Creates the procurement commitment — vendor,
 * ordered quantities, agreed prices. No FI posting (value moves at GR/IV). This slice is domestic:
 * the order currency must equal the company functional currency (the GR valuation currency does too).
 */
@Injectable()
export class PurchaseOrderService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly partners: BusinessPartnerService,
    private readonly numbering: NumberingService,
  ) {}

  async create(dto: CreatePurchaseOrderDto, actor = 'system') {
    const company = await this.getCompany(dto.companyCodeId);
    // Domestic slice: order currency == functional currency (GR posts stock in functional currency).
    if (dto.currency !== company.currency) {
      throw new BadRequestException(
        `purchase order currency ${dto.currency} must equal the company functional currency ` +
          `${company.currency} (foreign-currency import POs are a later slice)`,
      );
    }

    const bp = await this.partners.getBp(dto.vendorBpId);
    if (!bp.vendor) {
      throw new BadRequestException(`business partner ${dto.vendorBpId} has no vendor role`);
    }
    if (bp.vendor.purchasingBlock) {
      throw new ConflictException(`vendor ${dto.vendorBpId} is blocked for purchasing`);
    }

    if (dto.purchasingOrgId) {
      const [org] = await this.db
        .select({ companyCodeId: schema.purchasingOrg.companyCodeId })
        .from(schema.purchasingOrg)
        .where(eq(schema.purchasingOrg.id, dto.purchasingOrgId));
      if (!org) throw new NotFoundException(`purchasing org ${dto.purchasingOrgId} not found`);
      if (org.companyCodeId !== dto.companyCodeId) {
        throw new BadRequestException('purchasing org belongs to another company code');
      }
    }

    await this.validateItems(dto);

    return this.db.transaction(async (tx) => {
      const docNo = await this.numbering.next(NUMBER_OBJECT_PO, 'GLOBAL', tx);
      const [header] = await tx
        .insert(schema.purchaseOrder)
        .values({
          docType: DOC_TYPE_PURCHASE_ORDER,
          docNo,
          status: 'ORDERED',
          companyCodeId: dto.companyCodeId,
          vendorBpId: dto.vendorBpId,
          purchasingOrgId: dto.purchasingOrgId ?? null,
          currency: dto.currency,
          orderDate: dto.orderDate,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning({ id: schema.purchaseOrder.id });
      if (!header) throw new Error('purchase_order insert returned no row');

      await tx.insert(schema.purchaseOrderItem).values(
        dto.items.map((item, i) => ({
          purchaseOrderId: header.id,
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

      return { purchaseOrderId: header.id, docNo, status: 'ORDERED' as const };
    });
  }

  /** Header + items (line order), or 404. */
  async getPurchaseOrder(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.purchaseOrder)
      .where(eq(schema.purchaseOrder.id, id));
    if (!header) throw new NotFoundException(`purchase order ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.purchaseOrderItem)
      .where(eq(schema.purchaseOrderItem.purchaseOrderId, id))
      .orderBy(asc(schema.purchaseOrderItem.lineNo));
    return { ...header, items };
  }

  async listPurchaseOrders(q: PurchaseOrderQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.purchaseOrder)
      .where(this.listWhere(q))
      .orderBy(desc(schema.purchaseOrder.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countPurchaseOrders(q: PurchaseOrderQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.purchaseOrder)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: PurchaseOrderQuery) {
    return and(
      q.companyCodeId ? eq(schema.purchaseOrder.companyCodeId, q.companyCodeId) : undefined,
      q.vendorBpId ? eq(schema.purchaseOrder.vendorBpId, q.vendorBpId) : undefined,
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
  private async validateItems(dto: CreatePurchaseOrderDto): Promise<void> {
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
}
