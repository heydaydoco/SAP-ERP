/**
 * Sales (O2C) shared constants — doc types, doc_flow node/edge names, account-determination keys, and
 * number-range objects used across sales-order / delivery / billing. Mirrors procurement.constants.
 */

/** Document types (SAP BLART/essence) owned by sales documents. */
export const DOC_TYPE_SALES_ORDER = 'SO';
/** A delivery wraps a 601 goods movement; it ADOPTS that movement's GM-<year> doc_no (§10). */
export const DOC_TYPE_DELIVERY = 'DL';
export const DOC_TYPE_BILLING = 'BL';

/** doc_flow node types (§4.3). SO/billing documents + the SO/billing item granularity work at. */
export const DOC_FLOW_TYPE_SO = 'sales.sales_order';
export const DOC_FLOW_TYPE_SO_ITEM = 'sales.sales_order_item';
export const DOC_FLOW_TYPE_BILLING = 'sales.billing';
export const DOC_FLOW_TYPE_BILLING_ITEM = 'sales.billing_item';

/**
 * doc_flow node types for the inventory goods movement (the GI) the delivery posts. The engine writes
 * the `DELIVERS` edges FROM these nodes (movement header / line) onto the SO (header / item), exactly as
 * a GR writes `RECEIVES` — so delivered qty derives from `goods_movement_item.qty` via the DELIVERS join.
 */
export const DOC_FLOW_TYPE_GM = 'inventory.goods_movement';
export const DOC_FLOW_TYPE_GM_ITEM = 'inventory.goods_movement_item';

/**
 * doc_flow relationships: a delivery's GI DELIVERS a SO (item) — the single source of truth for the
 * derived open-to-deliver qty; a billing BILLS a SO item (lineage/drill-down, §4.3). Neither is a POSTS
 * edge: the GI journal's POSTS edge is written by the engine (movement→journal), and a billing
 * deliberately writes NO POSTS edge onto its AR journal (so `JournalService.reverse()` can correct it).
 */
export const REL_DELIVERS = 'DELIVERS';
export const REL_BILLS = 'BILLS';

/**
 * account_determination transaction key for COGS (매출원가) — the sales-GI (delivery 601) offset. A
 * SINGLE WILDCARD rule (no valuation class) this slice; the BSX (stock) leg still resolves per valuation
 * class. The delivery passes this as `GoodsMovementPostOptions.offsetKey` so the engine debits COGS
 * instead of GBB. Never hard-coded (§4.5) — a missing rule aborts the whole GI atomically.
 */
export const COGS_KEY = 'COGS';

/** Sales goods-issue / delivery movement type (MAP-valued issue; the engine routes the offset to COGS). */
export const MOVEMENT_TYPE_GI_SALES = '601';

/** Number-range objects (SAP Number Range). SO + billing are global-scoped (like the PO range). */
export const NUMBER_OBJECT_SO = 'sales.sales_order';
export const NUMBER_OBJECT_BILLING = 'sales.billing';
