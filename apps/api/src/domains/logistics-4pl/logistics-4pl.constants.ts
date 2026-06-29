/**
 * Logistics-4PL shared constants — doc type, doc_flow node/edge names, and the number-range object. This
 * slice ships the `shipment` (선적) backbone of the 4PL logistics domain. Mirrors trade-compliance.constants /
 * sales.constants. Naming follows the established split: doc_flow node types use the FULL domain snake
 * (`logistics_4pl.*`, like `trade_compliance.export_declaration`); the number-range object uses the SHORT
 * namespace (`logistics.*`, like `trade.export_declaration`).
 */

/** Document type (SAP BLART/essence) owned by the shipment. 'SH' / 'SH-' kept aligned (like ED/IM/DD). */
export const DOC_TYPE_SHIPMENT = 'SH';

/** Document type for a freight settlement (운임 정산) — the domain's first FI document. 'FR' / 'FR-' aligned. */
export const DOC_TYPE_FREIGHT = 'FR';

/**
 * Document type for a shipping document set (선적 서류세트 — B/L·CI·PL bundled per shipment). 'SD' / 'SD-'
 * aligned (free across domains — sales uses SO/DL/BL). A NON-POSTING physical record, like the shipment.
 */
export const DOC_TYPE_SHIPPING_DOC = 'SD';

/** doc_flow node type (§4.3) — the shipment header (item-granularity edges are not written). */
export const DOC_FLOW_TYPE_SHIPMENT = 'logistics_4pl.shipment';

/** doc_flow node type for a freight settlement; SETTLES → its shipment, POSTS → its KR journal. */
export const DOC_FLOW_TYPE_FREIGHT_SETTLEMENT = 'logistics_4pl.freight_settlement';

/** doc_flow node type for a shipping document set; DOCUMENTS → its shipment (physical lineage, no journal). */
export const DOC_FLOW_TYPE_SHIPPING_DOCUMENT = 'logistics_4pl.shipping_document';

/**
 * doc_flow node type for the DELIVERY (출고전표) a shipment carries — the physical lineage target, keyed by
 * `delivery.id`. Distinct from `inventory.goods_movement` (the GI node export_declaration's DECLARES edge
 * targets): a shipment hangs off the delivery WRAPPER (which carries the SO/plant/ship-to context), not the
 * raw goods movement. Referenced as a PLAIN STRING target — the doc_flow graph is generic (no FK, no
 * cross-domain module import). The same delivery's GI is what 수출신고 anchors to, so shipment ↔ 신고 are tied
 * through one shared physical truth (different nodes, same delivery/GI).
 */
export const DOC_FLOW_TYPE_DELIVERY = 'sales.delivery';

/**
 * doc_flow relationship: a shipment CONTAINS each delivery it carries — newer document → the earlier physical
 * document it derives from (like landed-cost CAPITALIZES / drawback REFUNDS). NOT a POSTS edge (the shipment
 * owns no journal). One edge per distinct delivery (consolidation = N edges). Direction: shipment → delivery.
 */
export const REL_CONTAINS = 'CONTAINS';

/**
 * doc_flow relationship: a freight settlement SETTLES a shipment — the freight document → the earlier 선적 it
 * is the freight cost for (lineage/drill-down only; NOT a POSTS edge). Direction: freight_settlement → shipment.
 */
export const REL_SETTLES = 'SETTLES';

/**
 * doc_flow relationship: a freight settlement POSTS its KR journal. `POSTS` matches the literal the FI
 * reverse-guard checks (same as procurement landed-cost / IV) — the freight's KR journal is thereby
 * subledger-owned (FI reverse refused; correction is a future freight-cancel, not a bare GL reversal).
 * Direction: freight_settlement → journal.
 */
export const REL_POSTS = 'POSTS';

/**
 * doc_flow relationship: a shipping document set DOCUMENTS a shipment — the 서류 묶음 → the earlier 선적 it
 * documents (physical lineage/drill-down only; NOT a POSTS edge — the set owns no journal, like
 * export_declaration's DECLARES). Direction: shipping_document_set → shipment.
 */
export const REL_DOCUMENTS = 'DOCUMENTS';

/**
 * account_determination transaction key for 지급운임 (freight expense, the Dr leg of a freight settlement).
 * Resolved from the config table per chart of accounts — never hard-coded (§4.5), like WRX/PRD/COGS.
 */
export const FREIGHT_KEY = 'FREIGHT';

/** Number-range object (SAP Number Range) — global-scoped, like the ED-/IM-/DD- ranges. doc_no = SH-NNNNNN. */
export const NUMBER_OBJECT_SHIPMENT = 'logistics.shipment';

/** Number-range object for freight settlements — global-scoped like SH-. doc_no = FR-NNNNNN (the KR journal
 * it raises draws the finance.ap_invoice KR range). */
export const NUMBER_OBJECT_FREIGHT = 'logistics.freight_settlement';

/** Number-range object for shipping document sets — global-scoped like SH-/FR-. doc_no = SD-NNNNNN. */
export const NUMBER_OBJECT_SHIPPING_DOC = 'logistics.shipping_document';
