import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import {
  DOC_FLOW_REL_POSTS,
  DOC_FLOW_TYPE as DOC_FLOW_TYPE_GM,
  GoodsMovementService,
  type GoodsMovementPostOptions,
  type PostedGoodsMovement,
} from '../goods-movement/goods-movement.service.js';
import type { CreateGoodsMovementDto } from '../goods-movement/goods-movement.dto.js';
import { formatScaled6, parseScaled6 } from '../inventory/map.js';
import { classifyDiff, formatSignedScaled6 } from './physical-inventory-diff.js';
import {
  DOC_FLOW_TYPE_PI,
  DOC_TYPE_PHYSICAL_INVENTORY,
  IDI_KEY,
  MOVEMENT_TYPE_PI_GAIN,
  MOVEMENT_TYPE_PI_LOSS,
  NUMBER_OBJECT_PI,
  REL_ADJUSTS,
} from './physical-inventory.constants.js';
import type {
  CreatePhysicalInventoryDto,
  PhysicalInventoryQuery,
} from './physical-inventory.dto.js';

/** One stock adjustment (701 or 702) the count posted, with the journal it raised. */
export interface PhysicalInventoryAdjustment {
  movementType: string;
  goodsMovementId: string;
  /** The adjustment movement's GM-<year> document number. */
  docNo: string;
  /** The journal (701: Dr BSX / Cr IDI · 702: Dr IDI / Cr BSX), or null on a zero-value adjustment. */
  journalId: string | null;
}

export interface PostedPhysicalInventory {
  physicalInventoryId: string;
  /** The count document's own PI-NNNNNN number. */
  docNo: string;
  status: 'POSTED';
  /** ≤2 adjustments: a 701 gain (gains) and/or a 702 loss (losses); empty when every diff is 0. */
  adjustments: PhysicalInventoryAdjustment[];
  replayed?: boolean;
}

/** A counted line classified into its adjustment direction (resume input). */
interface AdjustmentLine {
  materialId: string;
  storageLocationId: string;
  magnitude6: bigint;
}

/**
 * Physical-inventory (재고 실사) orchestrator (inventory-warehouse.physical-inventory = SAP MI01/MI07
 * essence) — the MIRROR of the delivery / goods-receipt orchestrators on the counting side. A count's
 * stock adjustment is NOT a new engine: it REUSES the goods-movement engine (movement types **701**
 * gain / **702** loss, the single source of stock changes → FI) with the offset routed to **IDI
 * (재고조정손익)** and an **ADJUSTS** edge linking each adjustment movement back to the count document — all
 * committed ATOMICALLY by that engine (§5.2).
 *
 *   701 (gain): Dr BSX (stock) / Cr IDI, at the current MAP · 702 (loss): Dr IDI / Cr BSX, at the MAP.
 *
 * Flow (count + post are immediate this slice — separation/freeze are DEFERRED): the count document is
 * written FIRST (`book_qty` snapshot from `stock.qty` + entered `physical_qty` + `diff_qty`), status
 * COUNTED, idempotent on (plant, posting_key); then each non-zero line difference posts through the
 * engine — gains as ONE 701 movement, losses as ONE 702 movement — and the document flips to POSTED.
 * A count whose every line matches the book posts NO movement (diff_qty=0 ⇒ no movement/journal). The
 * snapshot is authoritative: a replay (or a crash mid-post) re-drives the adjustments from the stored
 * `diff_qty`, never re-reading live stock, and the engine's (plant, posting_key) gate makes each
 * re-post a no-op — so the count is exactly-once even across retries.
 */
@Injectable()
export class PhysicalInventoryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly numbering: NumberingService,
    private readonly movements: GoodsMovementService,
  ) {}

  async count(dto: CreatePhysicalInventoryDto, actor = 'system'): Promise<PostedPhysicalInventory> {
    // Idempotency (§5.2): a replay of an existing (plant, posting_key) count returns its live state.
    // A COUNTED doc (a crash between the snapshot and the adjustment, or a prior posting failure)
    // re-drives the adjustments from the STORED snapshot — never recomputing the diff from live stock.
    const existing = await this.findByKey(dto.plantId, dto.postingKey);
    if (existing) {
      if (existing.status === 'POSTED') {
        return {
          physicalInventoryId: existing.id,
          docNo: existing.docNo,
          status: 'POSTED',
          adjustments: await this.adjustmentsOf(existing.id),
          replayed: true,
        };
      }
      return this.resume(existing, actor, true);
    }

    // A (material, storage location) pair is counted once per document.
    const seen = new Set<string>();
    for (const it of dto.items) {
      const key = `${it.materialId}:${it.storageLocationId}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          'duplicate count line for the same material + storage location in one document',
        );
      }
      seen.add(key);
    }

    // Snapshot book_qty (the storage location's stock.qty) + the entered physical_qty per line.
    const lines: {
      lineNo: number;
      materialId: string;
      storageLocationId: string;
      book6: bigint;
      phys6: bigint;
      diff6: bigint;
    }[] = [];
    for (const [i, it] of dto.items.entries()) {
      const book6 = await this.stockQty6(it.materialId, it.storageLocationId);
      const phys6 = parseScaled6(it.physicalQty);
      lines.push({
        lineNo: i + 1,
        materialId: it.materialId,
        storageLocationId: it.storageLocationId,
        book6,
        phys6,
        diff6: phys6 - book6,
      });
    }

    const docId = randomUUID();
    const doc = await this.insertDoc(docId, dto, lines, actor);
    return this.resume(doc, actor, doc.id !== docId);
  }

  /** Header + items (line order) + the adjustments it posted, or 404. */
  async getPhysicalInventory(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.physicalInventoryDoc)
      .where(eq(schema.physicalInventoryDoc.id, id));
    if (!header) throw new NotFoundException(`physical inventory ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.physicalInventoryItem)
      .where(eq(schema.physicalInventoryItem.physicalInventoryDocId, id))
      .orderBy(asc(schema.physicalInventoryItem.lineNo));
    return { ...header, items, adjustments: await this.adjustmentsOf(id) };
  }

  async listPhysicalInventories(q: PhysicalInventoryQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.physicalInventoryDoc)
      .where(this.listWhere(q))
      .orderBy(desc(schema.physicalInventoryDoc.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countPhysicalInventories(q: PhysicalInventoryQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.physicalInventoryDoc)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: PhysicalInventoryQuery) {
    return and(q.plantId ? eq(schema.physicalInventoryDoc.plantId, q.plantId) : undefined);
  }

  /**
   * Post the count's stock adjustments from the STORED snapshot (idempotent on the engine's
   * (plant, posting_key) gate), then flip the document to POSTED. Gains post as one 701 movement,
   * losses as one 702; a count with only zero diffs posts nothing and finalizes straight to POSTED.
   */
  private async resume(
    doc: typeof schema.physicalInventoryDoc.$inferSelect,
    actor: string,
    replayed: boolean,
  ): Promise<PostedPhysicalInventory> {
    const items = await this.db
      .select()
      .from(schema.physicalInventoryItem)
      .where(eq(schema.physicalInventoryItem.physicalInventoryDocId, doc.id))
      .orderBy(asc(schema.physicalInventoryItem.lineNo));

    const gains: AdjustmentLine[] = [];
    const losses: AdjustmentLine[] = [];
    for (const it of items) {
      const cls = classifyDiff(parseScaled6(it.bookQty), parseScaled6(it.physicalQty));
      if (!cls) continue; // diff 0 — no adjustment for this line
      const line: AdjustmentLine = {
        materialId: it.materialId,
        storageLocationId: it.storageLocationId,
        magnitude6: cls.magnitude6,
      };
      (cls.movementType === MOVEMENT_TYPE_PI_GAIN ? gains : losses).push(line);
    }

    const adjustments: PhysicalInventoryAdjustment[] = [];
    if (gains.length > 0) {
      const posted = await this.postAdjustment(doc, MOVEMENT_TYPE_PI_GAIN, gains, actor);
      adjustments.push({
        movementType: MOVEMENT_TYPE_PI_GAIN,
        goodsMovementId: posted.goodsMovementId,
        docNo: posted.docNo,
        journalId: posted.journalId,
      });
    }
    if (losses.length > 0) {
      const posted = await this.postAdjustment(doc, MOVEMENT_TYPE_PI_LOSS, losses, actor);
      adjustments.push({
        movementType: MOVEMENT_TYPE_PI_LOSS,
        goodsMovementId: posted.goodsMovementId,
        docNo: posted.docNo,
        journalId: posted.journalId,
      });
    }

    if (doc.status !== 'POSTED') {
      await this.db
        .update(schema.physicalInventoryDoc)
        .set({ status: 'POSTED', updatedAt: new Date(), updatedBy: actor })
        .where(eq(schema.physicalInventoryDoc.id, doc.id));
    }

    return {
      physicalInventoryId: doc.id,
      docNo: doc.docNo,
      status: 'POSTED',
      adjustments,
      replayed: replayed || undefined,
    };
  }

  /** Build the internal 701/702 goods movement (offset → IDI, ADJUSTS edge → the count doc) and post it. */
  private async postAdjustment(
    doc: typeof schema.physicalInventoryDoc.$inferSelect,
    movementType: typeof MOVEMENT_TYPE_PI_GAIN | typeof MOVEMENT_TYPE_PI_LOSS,
    lines: readonly AdjustmentLine[],
    actor: string,
  ): Promise<PostedGoodsMovement> {
    const movementDto: CreateGoodsMovementDto = {
      plantId: doc.plantId,
      movementType,
      postingDate: doc.postingDate,
      documentDate: doc.documentDate,
      headerText: doc.headerText ?? undefined,
      // Per-direction, per-document deterministic key: the engine's (plant, key) gate makes a replay
      // (or a crash-recovery re-post) return the same movement instead of double-adjusting stock.
      postingKey: `pi:${doc.id}:${movementType}`,
      items: lines.map((l) => ({
        materialId: l.materialId,
        storageLocationId: l.storageLocationId,
        qty: formatScaled6(l.magnitude6),
      })),
    };
    const opts: GoodsMovementPostOptions = {
      offsetKey: IDI_KEY,
      headerDocFlowLinks: [{ targetType: DOC_FLOW_TYPE_PI, targetId: doc.id, relType: REL_ADJUSTS }],
    };
    return this.movements.post(movementDto, actor, opts);
  }

  /**
   * The count document, written FIRST (status COUNTED) as the authoritative snapshot. Idempotent on
   * (plant, posting_key): a concurrent/replayed insert keeps the winner's row + snapshot; the doc_no is
   * drawn from the global PI- range. Returns the live row (this call's or the winner's).
   */
  private async insertDoc(
    docId: string,
    dto: CreatePhysicalInventoryDto,
    lines: readonly {
      lineNo: number;
      materialId: string;
      storageLocationId: string;
      book6: bigint;
      phys6: bigint;
      diff6: bigint;
    }[],
    actor: string,
  ): Promise<typeof schema.physicalInventoryDoc.$inferSelect> {
    return this.db.transaction(async (tx) => {
      const docNo = await this.numbering.next(NUMBER_OBJECT_PI, 'GLOBAL', tx);
      await tx
        .insert(schema.physicalInventoryDoc)
        .values({
          id: docId,
          docType: DOC_TYPE_PHYSICAL_INVENTORY,
          docNo,
          status: 'COUNTED',
          postingKey: dto.postingKey,
          plantId: dto.plantId,
          postingDate: dto.postingDate,
          documentDate: dto.documentDate ?? dto.postingDate,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .onConflictDoNothing({
          target: [schema.physicalInventoryDoc.plantId, schema.physicalInventoryDoc.postingKey],
        });
      const [doc] = await tx
        .select()
        .from(schema.physicalInventoryDoc)
        .where(
          and(
            eq(schema.physicalInventoryDoc.plantId, dto.plantId),
            eq(schema.physicalInventoryDoc.postingKey, dto.postingKey),
          ),
        );
      if (!doc) throw new Error('physical_inventory_doc missing after ensure');
      const existingItems = await tx
        .select({ id: schema.physicalInventoryItem.id })
        .from(schema.physicalInventoryItem)
        .where(eq(schema.physicalInventoryItem.physicalInventoryDocId, doc.id));
      if (existingItems.length === 0) {
        await tx.insert(schema.physicalInventoryItem).values(
          lines.map((l) => ({
            physicalInventoryDocId: doc.id,
            lineNo: l.lineNo,
            materialId: l.materialId,
            plantId: dto.plantId,
            storageLocationId: l.storageLocationId,
            bookQty: formatScaled6(l.book6),
            physicalQty: formatScaled6(l.phys6),
            diffQty: formatSignedScaled6(l.diff6),
            createdBy: actor,
            updatedBy: actor,
          })),
        );
      }
      return doc;
    });
  }

  private async stockQty6(materialId: string, storageLocationId: string): Promise<bigint> {
    const [row] = await this.db
      .select({ qty: schema.stock.qty })
      .from(schema.stock)
      .where(
        and(
          eq(schema.stock.materialId, materialId),
          eq(schema.stock.storageLocationId, storageLocationId),
        ),
      );
    return row ? parseScaled6(row.qty) : 0n;
  }

  private async findByKey(plantId: string, postingKey: string) {
    const [row] = await this.db
      .select()
      .from(schema.physicalInventoryDoc)
      .where(
        and(
          eq(schema.physicalInventoryDoc.plantId, plantId),
          eq(schema.physicalInventoryDoc.postingKey, postingKey),
        ),
      );
    return row;
  }

  /** The adjustment movements ADJUSTS-linked to a count document (for replay + drill-down). */
  private async adjustmentsOf(physicalInventoryId: string): Promise<PhysicalInventoryAdjustment[]> {
    const edges = await this.db
      .select({ sourceId: schema.docFlow.sourceId })
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.targetType, DOC_FLOW_TYPE_PI),
          eq(schema.docFlow.targetId, physicalInventoryId),
          eq(schema.docFlow.relType, REL_ADJUSTS),
        ),
      );
    const out: PhysicalInventoryAdjustment[] = [];
    for (const e of edges) {
      const [gm] = await this.db
        .select({
          id: schema.goodsMovement.id,
          docNo: schema.goodsMovement.docNo,
          movementType: schema.goodsMovement.movementType,
        })
        .from(schema.goodsMovement)
        .where(eq(schema.goodsMovement.id, e.sourceId));
      if (!gm) continue;
      out.push({
        movementType: gm.movementType,
        goodsMovementId: gm.id,
        docNo: gm.docNo,
        journalId: await this.journalIdOf(gm.id),
      });
    }
    return out.sort((a, b) => a.movementType.localeCompare(b.movementType));
  }

  private async journalIdOf(goodsMovementId: string): Promise<string | null> {
    const [edge] = await this.db
      .select({ targetId: schema.docFlow.targetId })
      .from(schema.docFlow)
      .where(
        and(
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_GM),
          eq(schema.docFlow.sourceId, goodsMovementId),
          eq(schema.docFlow.relType, DOC_FLOW_REL_POSTS),
        ),
      );
    return edge?.targetId ?? null;
  }
}
