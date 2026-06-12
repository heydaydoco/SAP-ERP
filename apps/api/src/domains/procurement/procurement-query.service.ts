import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../database/database.module.js';
import { parseScaled6 } from '../inventory-warehouse/inventory/map.js';
import {
  DOC_FLOW_TYPE_GM_ITEM,
  DOC_FLOW_TYPE_PO_ITEM,
  REL_RECEIVES,
} from './procurement.constants.js';

/** Aggregated quantity + value against a PO item (scale-6 qty bigint; amount NUMERIC(18,4) string). */
export interface PoItemAggregate {
  qty6: bigint;
  /**
   * Σ amount in the row's own currency (NUMERIC(18,4)). For a goods receipt this is the FUNCTIONAL
   * (KRW) value the engine posted to BSX/WRX; for an invoice it is the document-currency invoiced net.
   */
  amount: string;
  /**
   * Σ of the import-GR FOREIGN line value (document currency) — set only on the received aggregate of
   * a foreign PO (NULL/absent for a domestic GR and for the invoiced aggregate). The GR/IR open report
   * uses it so a foreign PO's open value is reported in the PO (document) currency, against the
   * document-currency invoiced net — both sides in the same currency.
   */
  documentAmount?: string | null;
}

const ZERO_AGG: PoItemAggregate = { qty6: 0n, amount: '0.0000', documentAmount: null };

/**
 * Procurement derivation hub (D4 — "received"/"invoiced" are DERIVED, never stored flags). Received
 * qty/value comes from the goods-movement lines that RECEIVES-link a PO item (through the generic
 * doc_flow graph, §4.3); invoiced qty/value comes from the linked invoice_verification items. The
 * goods-receipt over-delivery check and the invoice 3-way match both read these aggregates, and the
 * GR/IR (입고미착) open balance per PO item is `received − invoiced` in both quantity and value.
 *
 * Reads are NOT transaction-scoped: they are pre-checks (best-effort) ahead of the posting tx, so a
 * rare concurrent GR/IV pair can both pass an over-delivery/over-invoice gate — the FI integrity
 * (GR/IR self-clearing, balanced journals) is unaffected; only the tolerance gate is advisory.
 * Movement/IV reversal is out of this slice, so every linked row counts.
 */
@Injectable()
export class ProcurementQueryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Σ received quantity + value per PO item id (RECEIVES edges → goods_movement_item). */
  async receivedByPoItem(poItemIds: readonly string[]): Promise<Map<string, PoItemAggregate>> {
    const result = new Map<string, PoItemAggregate>();
    if (poItemIds.length === 0) return result;
    const rows = await this.db
      .select({
        poItemId: schema.docFlow.targetId,
        qty: sql<string>`coalesce(sum(${schema.goodsMovementItem.qty}), 0)`,
        amount: sql<string>`coalesce(sum(${schema.goodsMovementItem.amount}), 0)`,
        // Raw SUM (no coalesce): NULL when every line is domestic, the Σ foreign value otherwise — so
        // a foreign PO item reports its received value in the document currency, not 0.
        documentAmount: sql<string | null>`sum(${schema.goodsMovementItem.documentAmount})`,
      })
      .from(schema.docFlow)
      .innerJoin(
        schema.goodsMovementItem,
        eq(schema.docFlow.sourceId, schema.goodsMovementItem.id),
      )
      .where(
        and(
          eq(schema.docFlow.relType, REL_RECEIVES),
          eq(schema.docFlow.sourceType, DOC_FLOW_TYPE_GM_ITEM),
          eq(schema.docFlow.targetType, DOC_FLOW_TYPE_PO_ITEM),
          inArray(schema.docFlow.targetId, [...poItemIds]),
        ),
      )
      .groupBy(schema.docFlow.targetId);
    for (const r of rows) {
      result.set(r.poItemId, {
        qty6: parseScaled6(r.qty),
        amount: toNumeric4(r.amount),
        documentAmount: r.documentAmount == null ? null : toNumeric4(r.documentAmount),
      });
    }
    return result;
  }

  /** Σ invoiced quantity + value per PO item id (invoice_verification_item rows). */
  async invoicedByPoItem(poItemIds: readonly string[]): Promise<Map<string, PoItemAggregate>> {
    const result = new Map<string, PoItemAggregate>();
    if (poItemIds.length === 0) return result;
    const rows = await this.db
      .select({
        poItemId: schema.invoiceVerificationItem.purchaseOrderItemId,
        qty: sql<string>`coalesce(sum(${schema.invoiceVerificationItem.invoicedQty}), 0)`,
        amount: sql<string>`coalesce(sum(${schema.invoiceVerificationItem.amount}), 0)`,
      })
      .from(schema.invoiceVerificationItem)
      .where(inArray(schema.invoiceVerificationItem.purchaseOrderItemId, [...poItemIds]))
      .groupBy(schema.invoiceVerificationItem.purchaseOrderItemId);
    for (const r of rows) {
      result.set(r.poItemId, { qty6: parseScaled6(r.qty), amount: toNumeric4(r.amount) });
    }
    return result;
  }

  /**
   * GR/IR (입고미착) status of a PO: per item the ordered / received / invoiced / open quantities and
   * the open value = received value − invoiced value (what still sits on the WRX clearing account for
   * the line). Drives `GET /procurement/purchase-orders/:id/gr-ir`.
   */
  async grIrByPurchaseOrder(purchaseOrderId: string) {
    const [po] = await this.db
      .select()
      .from(schema.purchaseOrder)
      .where(eq(schema.purchaseOrder.id, purchaseOrderId));
    if (!po) throw new NotFoundException(`purchase order ${purchaseOrderId} not found`);
    const items = await this.db
      .select()
      .from(schema.purchaseOrderItem)
      .where(eq(schema.purchaseOrderItem.purchaseOrderId, purchaseOrderId))
      .orderBy(asc(schema.purchaseOrderItem.lineNo));

    const ids = items.map((i) => i.id);
    const [received, invoiced] = await Promise.all([
      this.receivedByPoItem(ids),
      this.invoicedByPoItem(ids),
    ]);

    const lines = items.map((it) => {
      const rec = received.get(it.id) ?? ZERO_AGG;
      const inv = invoiced.get(it.id) ?? ZERO_AGG;
      return {
        purchaseOrderItemId: it.id,
        lineNo: it.lineNo,
        materialId: it.materialId,
        currency: it.currency,
        orderedQty: it.orderedQty,
        receivedQty: scaled6(rec.qty6),
        invoicedQty: scaled6(inv.qty6),
        openQty: scaled6(rec.qty6 - inv.qty6),
        /**
         * Value still on GR/IR for this line, in the PO (document) currency — received value −
         * invoiced value. A foreign PO compares the received foreign value (`documentAmount`) against
         * the document-currency invoiced net; a domestic PO falls back to the functional `amount`
         * (KRW==document). The functional WRX GL itself nets via realized FX (the journal level).
         */
        grIrOpenAmount: subNumeric4(rec.documentAmount ?? rec.amount, inv.amount),
      };
    });

    return { purchaseOrderId, docNo: po.docNo, currency: po.currency, status: po.status, lines };
  }
}

/** Normalize a SUM() numeric (Postgres returns it at higher scale) to NUMERIC(18,4) string. */
function toNumeric4(value: string): string {
  const neg = value.startsWith('-');
  const [intPart = '0', fracRaw = ''] = value.replace('-', '').split('.');
  const frac = fracRaw.padEnd(4, '0').slice(0, 4);
  return `${neg ? '-' : ''}${intPart}.${frac}`;
}

/** Difference of two NUMERIC(18,4) strings, in whole minor-of-4 integer math. */
function subNumeric4(a: string, b: string): string {
  const scale = (v: string): bigint => {
    const neg = v.startsWith('-');
    const [intPart = '0', frac = ''] = v.replace('-', '').split('.');
    const scaled = BigInt(intPart) * 10000n + BigInt(frac.padEnd(4, '0').slice(0, 4) || '0');
    return neg ? -scaled : scaled;
  };
  const diff = scale(a) - scale(b);
  const neg = diff < 0n;
  const abs = (neg ? -diff : diff).toString().padStart(5, '0');
  const cut = abs.length - 4;
  return `${neg ? '-' : ''}${abs.slice(0, cut)}.${abs.slice(cut)}`;
}

/** Format a scale-6 bigint (may be negative) to a NUMERIC(18,6) string. */
function scaled6(value: bigint): string {
  const neg = value < 0n;
  const abs = (neg ? -value : value).toString().padStart(7, '0');
  const cut = abs.length - 6;
  return `${neg ? '-' : ''}${abs.slice(0, cut)}.${abs.slice(cut)}`;
}
