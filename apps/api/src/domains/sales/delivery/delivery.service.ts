import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import type { Money } from '@erp/kernel';
import { DB } from '../../../database/database.module.js';
import {
  GoodsMovementService,
  type GoodsMovementPostOptions,
} from '../../inventory-warehouse/goods-movement/goods-movement.service.js';
import { parseScaled6, formatScaled6 } from '../../inventory-warehouse/inventory/map.js';
import type { CreateGoodsMovementDto } from '../../inventory-warehouse/goods-movement/goods-movement.dto.js';
import { SalesQueryService } from '../sales-query.service.js';
import { exceedsOpen, openQty6 } from '../open-quantity.js';
import {
  COGS_KEY,
  DOC_FLOW_TYPE_SO,
  DOC_FLOW_TYPE_SO_ITEM,
  DOC_TYPE_DELIVERY,
  MOVEMENT_TYPE_GI_SALES,
  REL_DELIVERS,
} from '../sales.constants.js';
import type { CreateDeliveryDto } from './delivery.dto.js';

export interface PostedDelivery {
  deliveryId: string;
  /** Adopted from the GI goods movement (GM-<year>-NNNNNN) — the delivery shares the material doc number. */
  docNo: string;
  status: 'POSTED';
  goodsMovementId: string;
  /** The WA journal the GI posted (Dr COGS / Cr BSX). NULL only on a zero-value issue (no GL impact). */
  journalId: string | null;
  /** Per-line COGS (the engine's verbatim consumed value). */
  perItemCogs: { lineNo: number; amount: Money }[];
  /** Σ COGS of the issue. */
  totalCogs: Money;
  replayed?: boolean;
}

/**
 * Delivery / goods-issue orchestrator (sales.delivery = SAP VL01N + PGI) — the MIRROR of the
 * goods-receipt orchestrator on the O2C side. A delivery's physical goods issue is NOT a new engine: it
 * REUSES the inventory goods-movement engine (movement type **601**, the single source of stock changes
 * → FI) with two sales-specific twists, both committed ATOMICALLY by that engine (§5.2): the offset is
 * routed to **COGS (매출원가)** instead of GBB, and the movement (header) + each line are DELIVERS-linked
 * to the SO (item) in the same transaction.
 *
 *   GI journal (WA): Dr COGS (consumed value, at the current MAP) / Cr BSX (stock), per line.
 *
 * The thin `delivery`/`delivery_item` wrapper (출고전표 identity + ship-to) is written right after the
 * GI, idempotent on `goods_movement_id` so a replayed GI self-heals it (the GI itself — stock + COGS +
 * DELIVERS edges — is the atomic financial truth in the engine tx). Open-to-deliver = ordered − Σ
 * delivered (the DELIVERS-derived qty); a sloc shortfall is rejected by the engine's own over-issue
 * guard. The over-delivery pre-check is SKIPPED on a replayed posting key (the derived delivered qty
 * already includes this very issue — it would double-count itself, exactly the GR replay fence).
 */
@Injectable()
export class DeliveryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly movements: GoodsMovementService,
    private readonly query: SalesQueryService,
  ) {}

  async post(dto: CreateDeliveryDto, actor = 'system'): Promise<PostedDelivery> {
    const [so] = await this.db
      .select()
      .from(schema.salesOrder)
      .where(eq(schema.salesOrder.id, dto.salesOrderId));
    if (!so) throw new NotFoundException(`sales order ${dto.salesOrderId} not found`);
    if (so.status === 'CLOSED') {
      throw new BadRequestException(`sales order ${so.docNo} is CLOSED; cannot deliver against it`);
    }

    // Resolve the referenced SO items and verify they belong to this SO.
    const soItemIds = dto.items.map((i) => i.salesOrderItemId);
    const soItems = await this.db
      .select()
      .from(schema.salesOrderItem)
      .where(inArray(schema.salesOrderItem.id, soItemIds));
    const soItemById = new Map(soItems.map((r) => [r.id, r]));
    for (const id of soItemIds) {
      const item = soItemById.get(id);
      if (!item) throw new NotFoundException(`sales order item ${id} not found`);
      if (item.salesOrderId !== so.id) {
        throw new BadRequestException(`sales order item ${id} belongs to another sales order`);
      }
    }

    // A goods movement has ONE plant: every issued line must share it.
    const plants = new Set(soItemIds.map((id) => soItemById.get(id)!.plantId));
    if (plants.size > 1) {
      throw new BadRequestException(
        'a delivery issues lines of one plant only; split multi-plant SOs into separate deliveries',
      );
    }
    const plantId = [...plants][0]!;

    // Idempotency: a replay of an existing (plant, posting_key) movement must NOT re-run the
    // over-delivery guard (the derived delivered qty already includes this very issue — it would
    // double-count itself). The movement engine returns the existing document below; the wrapper
    // self-heals on goods_movement_id.
    const isReplay = dto.postingKey
      ? (await this.findMovementByKey(plantId, dto.postingKey)) !== undefined
      : false;

    // Over-delivery guard (best-effort pre-check) against the DERIVED delivered quantity. The running
    // map accumulates IN-DOCUMENT quantities too, so two lines on one SO item cannot slip past the gate
    // by each checking the pre-document aggregate alone. The sloc-level over-ISSUE guard is the engine's.
    if (!isReplay) {
      const delivered = await this.query.deliveredBySoItem(soItemIds);
      const running = new Map<string, bigint>();
      for (const line of dto.items) {
        const soItem = soItemById.get(line.salesOrderItemId)!;
        const ordered6 = parseScaled6(soItem.orderedQty);
        const prior6 = delivered.get(soItem.id)?.qty6 ?? 0n;
        const running6 = running.get(soItem.id) ?? 0n;
        const this6 = parseScaled6(line.qty);
        if (exceedsOpen(ordered6, prior6, running6, this6)) {
          throw new BadRequestException(
            `over-delivery on SO item line ${soItem.lineNo}: issuing ${line.qty} on top of ` +
              `${formatScaled6(prior6 + running6)} exceeds the open-to-deliver ` +
              `${formatScaled6(openQty6(ordered6, prior6, running6))} (ordered ${soItem.orderedQty})`,
          );
        }
        running.set(soItem.id, running6 + this6);
      }
    }

    // Build the internal goods-movement document: an UNPRICED 601 issue (the engine values it at the
    // current MAP — the consumed value IS the COGS). The GI issues from the SO line's own storage
    // location (no override, §8).
    const movementDto: CreateGoodsMovementDto = {
      plantId,
      movementType: MOVEMENT_TYPE_GI_SALES,
      postingDate: dto.postingDate,
      documentDate: dto.documentDate,
      headerText: dto.headerText,
      postingKey: dto.postingKey,
      items: dto.items.map((line) => {
        const soItem = soItemById.get(line.salesOrderItemId)!;
        return {
          materialId: soItem.materialId,
          storageLocationId: soItem.storageLocationId,
          qty: line.qty,
        };
      }),
    };

    // Route the offset to COGS and DELIVERS-link the SO (header) + each SO item (line) — all in the
    // movement engine's own transaction (the DELIVERS edges are the single source of derived open-qty).
    const opts: GoodsMovementPostOptions = {
      offsetKey: COGS_KEY,
      headerDocFlowLinks: [
        { targetType: DOC_FLOW_TYPE_SO, targetId: so.id, relType: REL_DELIVERS },
      ],
      itemDocFlowLinks: dto.items.map((line) => ({
        targetType: DOC_FLOW_TYPE_SO_ITEM,
        targetId: line.salesOrderItemId,
        relType: REL_DELIVERS,
      })),
    };

    const posted = await this.movements.post(movementDto, actor, opts);

    // Write the thin shipping wrapper, idempotent on goods_movement_id (one delivery per GI). On a
    // replay (movement pre-existing) or a partial first-call failure, this finds/heals the same row.
    const header = await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.delivery)
        .values({
          docType: DOC_TYPE_DELIVERY,
          docNo: posted.docNo,
          status: 'POSTED',
          postingKey: dto.postingKey ?? null,
          salesOrderId: so.id,
          goodsMovementId: posted.goodsMovementId,
          plantId,
          postingDate: dto.postingDate,
          documentDate: dto.documentDate ?? dto.postingDate,
          shipToCountry: so.shipToCountry,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .onConflictDoNothing({ target: schema.delivery.goodsMovementId });
      const [row] = await tx
        .select()
        .from(schema.delivery)
        .where(eq(schema.delivery.goodsMovementId, posted.goodsMovementId));
      if (!row) throw new Error('delivery row missing after ensure');
      const existingItems = await tx
        .select({ id: schema.deliveryItem.id })
        .from(schema.deliveryItem)
        .where(eq(schema.deliveryItem.deliveryId, row.id));
      if (existingItems.length === 0) {
        await tx.insert(schema.deliveryItem).values(
          dto.items.map((line, i) => ({
            deliveryId: row.id,
            lineNo: i + 1,
            salesOrderItemId: line.salesOrderItemId,
            qty: line.qty,
            createdBy: actor,
            updatedBy: actor,
          })),
        );
      }
      return row;
    });

    return {
      deliveryId: header.id,
      docNo: posted.docNo,
      status: 'POSTED',
      goodsMovementId: posted.goodsMovementId,
      journalId: posted.journalId,
      perItemCogs: posted.perItemConsumed,
      totalCogs: posted.totalConsumed,
      replayed: isReplay || undefined,
    };
  }

  /** Header + items (line order), or 404. */
  async getDelivery(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.delivery)
      .where(eq(schema.delivery.id, id));
    if (!header) throw new NotFoundException(`delivery ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.deliveryItem)
      .where(eq(schema.deliveryItem.deliveryId, id))
      .orderBy(asc(schema.deliveryItem.lineNo));
    return { ...header, items };
  }

  /** A SO's deliveries (drill-down), in document order. */
  async listForSalesOrder(salesOrderId: string) {
    return this.db
      .select()
      .from(schema.delivery)
      .where(eq(schema.delivery.salesOrderId, salesOrderId))
      .orderBy(asc(schema.delivery.docNo));
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
}
