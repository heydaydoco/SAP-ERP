import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../database/database.module.js';
import { parseScaled6 } from '../inventory-warehouse/inventory/map.js';
import {
  DOC_FLOW_TYPE_GM_ITEM,
  DOC_FLOW_TYPE_SO_ITEM,
  REL_DELIVERS,
} from './sales.constants.js';
import { openQty6 } from './open-quantity.js';

/** Aggregated quantity + value against a SO item (scale-6 qty bigint; amount NUMERIC(18,4) string). */
export interface SoItemAggregate {
  qty6: bigint;
  /**
   * Σ amount in the row's own currency (NUMERIC(18,4)). For a delivery this is the FUNCTIONAL (KRW) COGS
   * value the engine posted; for a billing it is the document-currency billed net.
   */
  amount: string;
}

const ZERO_AGG: SoItemAggregate = { qty6: 0n, amount: '0.0000' };

/**
 * Sales derivation hub (D4 — "delivered"/"billed" are DERIVED, never stored flags) — the MIRROR of
 * `ProcurementQueryService`. Delivered qty/value comes from the goods-movement (601 GI) lines that
 * `DELIVERS`-link a SO item (through the generic doc_flow graph, §4.3); billed qty/value comes from the
 * linked `billing_item` rows whose billing journal is NOT reversed (reversal-aware). The delivery
 * over-delivery check, the billing open-to-bill gate, and the O2C status report all read these.
 *
 * Reads are NOT transaction-scoped: best-effort pre-checks ahead of the posting tx (FI/stock integrity
 * never depends on them — the engine's own sloc over-issue guard does).
 */
@Injectable()
export class SalesQueryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Σ delivered quantity + COGS value per SO item id (DELIVERS edges → goods_movement_item). */
  async deliveredBySoItem(soItemIds: readonly string[]): Promise<Map<string, SoItemAggregate>> {
    const result = new Map<string, SoItemAggregate>();
    if (soItemIds.length === 0) return result;
    const rows = await this.db
      .select({
        soItemId: schema.docFlow.targetId,
        qty: sql<string>`coalesce(sum(${schema.goodsMovementItem.qty}), 0)`,
        amount: sql<string>`coalesce(sum(${schema.goodsMovementItem.amount}), 0)`,
      })
      .from(schema.docFlow)
      .innerJoin(schema.goodsMovementItem, eq(schema.docFlow.sourceId, schema.goodsMovementItem.id))
      .where(
        and(
          eq(schema.docFlow.relType, REL_DELIVERS),
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_GM_ITEM),
          eq(schema.docFlow.targetType, DOC_FLOW_TYPE_SO_ITEM),
          inArray(schema.docFlow.targetId, [...soItemIds]),
        ),
      )
      .groupBy(schema.docFlow.targetId);
    for (const r of rows) {
      result.set(r.soItemId, { qty6: parseScaled6(r.qty), amount: toNumeric4(r.amount) });
    }
    return result;
  }

  /**
   * Σ billed quantity + net per SO item id (billing_item rows), REVERSAL-AWARE: a billing whose AR
   * journal is REVERSED is excluded, so reversing a billing re-opens its quantity to bill. The
   * billing → sales_order_item link is also recorded as a BILLS doc_flow edge (§4.3 drill-down); the
   * aggregation uses the same-domain FK (its target equals the edge), joined to the journal status.
   */
  async billedBySoItem(soItemIds: readonly string[]): Promise<Map<string, SoItemAggregate>> {
    const result = new Map<string, SoItemAggregate>();
    if (soItemIds.length === 0) return result;
    const rows = await this.db
      .select({
        soItemId: schema.billingItem.salesOrderItemId,
        qty: sql<string>`coalesce(sum(${schema.billingItem.billedQty}), 0)`,
        amount: sql<string>`coalesce(sum(${schema.billingItem.amount}), 0)`,
      })
      .from(schema.billingItem)
      .innerJoin(schema.billing, eq(schema.billingItem.billingId, schema.billing.id))
      .innerJoin(schema.journalEntry, eq(schema.billing.journalEntryId, schema.journalEntry.id))
      .where(
        and(
          inArray(schema.billingItem.salesOrderItemId, [...soItemIds]),
          // Exclude REVERSED billing journals — a reversed billing re-opens its billed quantity.
          ne(schema.journalEntry.status, 'REVERSED'),
        ),
      )
      .groupBy(schema.billingItem.salesOrderItemId);
    for (const r of rows) {
      result.set(r.soItemId, { qty6: parseScaled6(r.qty), amount: toNumeric4(r.amount) });
    }
    return result;
  }

  /**
   * O2C status of a SO: per item the ordered / delivered / billed quantities, plus open-to-deliver
   * (ordered − delivered) and open-to-bill (delivered − billed). Drives
   * `GET /sales/sales-orders/:id/o2c`.
   */
  async o2cBySalesOrder(salesOrderId: string) {
    const [so] = await this.db
      .select()
      .from(schema.salesOrder)
      .where(eq(schema.salesOrder.id, salesOrderId));
    if (!so) throw new NotFoundException(`sales order ${salesOrderId} not found`);
    const items = await this.db
      .select()
      .from(schema.salesOrderItem)
      .where(eq(schema.salesOrderItem.salesOrderId, salesOrderId))
      .orderBy(asc(schema.salesOrderItem.lineNo));

    const ids = items.map((i) => i.id);
    const [delivered, billed] = await Promise.all([
      this.deliveredBySoItem(ids),
      this.billedBySoItem(ids),
    ]);

    const lines = items.map((it) => {
      const del = delivered.get(it.id) ?? ZERO_AGG;
      const bil = billed.get(it.id) ?? ZERO_AGG;
      const ordered6 = parseScaled6(it.orderedQty);
      return {
        salesOrderItemId: it.id,
        lineNo: it.lineNo,
        materialId: it.materialId,
        currency: it.currency,
        orderedQty: it.orderedQty,
        deliveredQty: scaled6(del.qty6),
        billedQty: scaled6(bil.qty6),
        openToDeliverQty: scaled6(openQty6(ordered6, del.qty6, 0n)),
        openToBillQty: scaled6(openQty6(del.qty6, bil.qty6, 0n)),
      };
    });

    return { salesOrderId, docNo: so.docNo, currency: so.currency, status: so.status, lines };
  }
}

/** Normalize a SUM() numeric (Postgres returns it at higher scale) to NUMERIC(18,4) string. */
function toNumeric4(value: string): string {
  const neg = value.startsWith('-');
  const [intPart = '0', fracRaw = ''] = value.replace('-', '').split('.');
  const frac = fracRaw.padEnd(4, '0').slice(0, 4);
  return `${neg ? '-' : ''}${intPart}.${frac}`;
}

/** Format a scale-6 bigint (may be negative) to a NUMERIC(18,6) string. */
function scaled6(value: bigint): string {
  const neg = value < 0n;
  const abs = (neg ? -value : value).toString().padStart(7, '0');
  const cut = abs.length - 6;
  return `${neg ? '-' : ''}${abs.slice(0, cut)}.${abs.slice(cut)}`;
}
