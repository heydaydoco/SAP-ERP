import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import {
  GoodsMovementService,
  type GoodsMovementPostOptions,
  type PostedGoodsMovement,
} from '../../inventory-warehouse/goods-movement/goods-movement.service.js';
import { formatScaled6, parseScaled6 } from '../../inventory-warehouse/inventory/map.js';
import type { CreateGoodsMovementDto } from '../../inventory-warehouse/goods-movement/goods-movement.dto.js';
import { ProcurementQueryService } from '../procurement-query.service.js';
import {
  DOC_FLOW_TYPE_PO,
  DOC_FLOW_TYPE_PO_ITEM,
  REL_RECEIVES,
  WRX_KEY,
} from '../procurement.constants.js';
import type { CreateGoodsReceiptDto } from './goods-receipt.dto.js';

/**
 * Over-delivery tolerance in basis points of the ordered quantity (this slice: 0 — received may not
 * exceed ordered; admin-config maintenance is a follow-up). Partial/multiple receipts are allowed.
 */
const OVER_DELIVERY_TOLERANCE_BP = 0n;

/**
 * Goods-receipt orchestrator (procurement.goods-receipt = SAP MIGO against a PO). A GR is NOT a new
 * document type — it REUSES the inventory goods-movement engine (movement type 101, the single
 * source of stock changes → FI) with two procurement-specific twists, both committed atomically by
 * that engine (§5.2): the offset is routed to **GR/IR clearing (WRX)** instead of GBB, and the
 * movement (header) + each line are RECEIVES-linked to the PO (item) in the same transaction.
 *
 *   GR journal (WE): Dr BSX (stock, qty × PO price) / Cr WRX (GR/IR), per line.
 *
 * The price comes from the PO item (101 is a priced receipt); quantity comes from the GR request.
 * Over-delivery beyond tolerance is rejected against the DERIVED received quantity. A GR receives
 * lines of ONE plant (a goods movement has a single plant); split across plants into separate GRs.
 */
@Injectable()
export class GoodsReceiptService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly movements: GoodsMovementService,
    private readonly query: ProcurementQueryService,
  ) {}

  async post(dto: CreateGoodsReceiptDto, actor = 'system'): Promise<PostedGoodsMovement> {
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrder)
      .where(eq(schema.purchaseOrder.id, dto.purchaseOrderId));
    if (!po) throw new NotFoundException(`purchase order ${dto.purchaseOrderId} not found`);
    if (po.status === 'CLOSED') {
      throw new BadRequestException(`purchase order ${po.docNo} is CLOSED; cannot receive against it`);
    }

    // Resolve the referenced PO items and verify they all belong to this PO.
    const poItemIds = dto.items.map((i) => i.purchaseOrderItemId);
    const poItems = await this.db
      .select()
      .from(schema.purchaseOrderItem)
      .where(inArray(schema.purchaseOrderItem.id, poItemIds));
    const poItemById = new Map(poItems.map((r) => [r.id, r]));
    for (const id of poItemIds) {
      const item = poItemById.get(id);
      if (!item) throw new NotFoundException(`purchase order item ${id} not found`);
      if (item.purchaseOrderId !== po.id) {
        throw new BadRequestException(`purchase order item ${id} belongs to another purchase order`);
      }
    }

    // A goods movement has ONE plant: every received line must share it.
    const plants = new Set(poItemIds.map((id) => poItemById.get(id)!.plantId));
    if (plants.size > 1) {
      throw new BadRequestException(
        'a goods receipt receives lines of one plant only; split multi-plant POs into separate GRs',
      );
    }
    const plantId = [...plants][0]!;

    // Idempotency: a replay of an existing (plant, posting_key) movement must NOT re-run the
    // over-delivery guard (the derived received qty already includes this very receipt — it would
    // double-count itself). The movement engine returns the existing document below.
    const isReplay = dto.postingKey
      ? (await this.findMovementByKey(plantId, dto.postingKey)) !== undefined
      : false;

    // Over-delivery guard (best-effort pre-check) against the DERIVED received quantity. The
    // running map accumulates IN-DOCUMENT quantities too, so two GR lines on the same PO item
    // cannot slip past the gate by each checking the pre-document aggregate alone.
    if (!isReplay) {
      const received = await this.query.receivedByPoItem(poItemIds);
      const running = new Map<string, bigint>();
      for (const line of dto.items) {
        const poItem = poItemById.get(line.purchaseOrderItemId)!;
        const ordered6 = parseScaled6(poItem.orderedQty);
        const already6 =
          (received.get(poItem.id)?.qty6 ?? 0n) + (running.get(poItem.id) ?? 0n);
        const this6 = parseScaled6(line.qty);
        const allowed6 = ordered6 + (ordered6 * OVER_DELIVERY_TOLERANCE_BP) / 10000n;
        if (already6 + this6 > allowed6) {
          throw new BadRequestException(
            `over-delivery on PO item line ${poItem.lineNo}: receiving ${line.qty} on top of ` +
              `${formatScaled6(already6)} exceeds the ordered ${poItem.orderedQty}`,
          );
        }
        running.set(poItem.id, (running.get(poItem.id) ?? 0n) + this6);
      }
    }

    // Build the internal goods-movement document: priced 101 receipt at the PO price.
    const movementDto: CreateGoodsMovementDto = {
      plantId,
      movementType: '101',
      postingDate: dto.postingDate,
      documentDate: dto.documentDate,
      headerText: dto.headerText,
      postingKey: dto.postingKey,
      items: dto.items.map((line) => {
        const poItem = poItemById.get(line.purchaseOrderItemId)!;
        return {
          materialId: poItem.materialId,
          storageLocationId: line.storageLocationId ?? poItem.storageLocationId,
          qty: line.qty,
          unitPrice: poItem.unitPrice,
        };
      }),
    };

    // Route the offset to GR/IR (WRX) and RECEIVES-link the PO (header) + each PO item (line),
    // all in the movement engine's own transaction.
    const opts: GoodsMovementPostOptions = {
      offsetKey: WRX_KEY,
      headerDocFlowLinks: [
        { targetType: DOC_FLOW_TYPE_PO, targetId: po.id, relType: REL_RECEIVES },
      ],
      itemDocFlowLinks: dto.items.map((line) => ({
        targetType: DOC_FLOW_TYPE_PO_ITEM,
        targetId: line.purchaseOrderItemId,
        relType: REL_RECEIVES,
      })),
    };

    return this.movements.post(movementDto, actor, opts);
  }

  /** An already-posted goods movement for this (plant, posting key), if any — the replay signal. */
  private async findMovementByKey(plantId: string, postingKey: string) {
    const [row] = await this.db
      .select({ id: schema.goodsMovement.id })
      .from(schema.goodsMovement)
      .where(
        and(
          eq(schema.goodsMovement.plantId, plantId),
          eq(schema.goodsMovement.postingKey, postingKey),
        ),
      );
    return row;
  }

  /** A PO's goods receipts: the goods movements RECEIVES-linked to it (drill-down), in doc order. */
  async listForPurchaseOrder(purchaseOrderId: string) {
    const edges = await this.db
      .select({ sourceId: schema.docFlow.sourceId })
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.targetType, DOC_FLOW_TYPE_PO),
          eq(schema.docFlow.relType, REL_RECEIVES),
          eq(schema.docFlow.targetId, purchaseOrderId),
        ),
      );
    const ids = edges.map((e) => e.sourceId);
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(schema.goodsMovement)
      .where(inArray(schema.goodsMovement.id, ids))
      .orderBy(asc(schema.goodsMovement.docNo));
  }
}
