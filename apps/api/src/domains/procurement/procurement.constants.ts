/**
 * Procurement shared constants — doc types, doc_flow node/edge names, account-determination keys, and
 * number-range objects used across purchase-order / goods-receipt / invoice-verification.
 */

/** Document types (SAP BLART/essence) owned by procurement documents. */
export const DOC_TYPE_PURCHASE_ORDER = 'PO';
export const DOC_TYPE_INVOICE_VERIFICATION = 'IV';
/** Landed cost (수입 부대비용 재고원가 배부 + 수입부가세) — the subsequent-debit document. */
export const DOC_TYPE_LANDED_COST = 'LC';

/** doc_flow node types (§4.3). PO/IV documents and the PO item granularity 3-way match works at. */
export const DOC_FLOW_TYPE_PO = 'procurement.purchase_order';
export const DOC_FLOW_TYPE_PO_ITEM = 'procurement.purchase_order_item';
export const DOC_FLOW_TYPE_IV = 'procurement.invoice_verification';
/** doc_flow node type for a landed-cost document; CAPITALIZES → PO items, POSTS → its journal. */
export const DOC_FLOW_TYPE_LANDED_COST = 'procurement.landed_cost';

/**
 * doc_flow node type for an inventory goods-movement LINE — the SOURCE of a GR's per-item `RECEIVES`
 * edge (mirrors inventory's `DOC_FLOW_ITEM_TYPE`). The received-qty aggregation joins on the
 * `goods_movement_item` PK, so this is a redundant-but-explicit guard that the edge's source really
 * is a movement line (intent-clarifying; never matches anything else).
 */
export const DOC_FLOW_TYPE_GM_ITEM = 'inventory.goods_movement_item';

/**
 * doc_flow relationships: a GR RECEIVES a PO (item); an IV INVOICES a PO; an IV POSTS its AP journal.
 * `POSTS` matches the literal the FI reverse-guard checks — an IV's KR journal is thereby
 * subledger-owned (FI reverse refused; correction is a future IV-cancel, not a bare GL reversal).
 */
export const REL_RECEIVES = 'RECEIVES';
export const REL_INVOICES = 'INVOICES';
export const REL_POSTS = 'POSTS';
/**
 * A landed-cost document CAPITALIZES (raises the inventory value of) the PO items it allocates onto —
 * lineage/drill-down only (the per-line capitalized share lives on landed_cost_item, not derived from
 * this edge). The single-document model posts the journal in the same doc, so there is no separate
 * cost-invoice settlement edge.
 */
export const REL_CAPITALIZES = 'CAPITALIZES';

/**
 * account_determination transaction key for GR/IR clearing (입고미착, SAP WRX). The GR credits it,
 * the IV debits it; the pair self-clears per PO item. Never hard-coded (§4.5).
 */
export const WRX_KEY = 'WRX';

/**
 * account_determination transaction key for the inventory price/cost difference (재고원가차이, SAP
 * PRD essence). Landed cost arriving AFTER stock was (partly) issued cannot capitalize the
 * already-issued share onto inventory (the empty_zero invariant), so that uncovered share is
 * expensed here instead. Never hard-coded (§4.5).
 */
export const PRD_KEY = 'PRD';

/**
 * Realized FX gain/loss keys for a FOREIGN (import) IV — REUSED from the clearing slice (#13), so no
 * new account-determination rows. WRX is relieved at the GR-date functional value; the difference vs
 * the invoice-date rate posts to these economic P&L accounts (외환차익/외환차손), exactly the
 * clearing residue pattern. Their GL accounts are `currency = null` (the gain/loss line is 0 in the
 * foreign document currency), already seeded as 9810/9820.
 */
export const REALIZED_FX_GAIN_KEY = 'REALIZED_FX_GAIN';
export const REALIZED_FX_LOSS_KEY = 'REALIZED_FX_LOSS';

/** Number-range objects (SAP Number Range). PO is global-scoped; IV is per-fiscal-year. */
export const NUMBER_OBJECT_PO = 'procurement.purchase_order';
export const NUMBER_OBJECT_IV = 'procurement.invoice_verification';
/** Landed-cost document range — global-scoped like IV (the AP open item draws the KR range). */
export const NUMBER_OBJECT_LANDED_COST = 'procurement.landed_cost';
