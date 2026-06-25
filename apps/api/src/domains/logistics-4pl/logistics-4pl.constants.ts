/**
 * Logistics-4PL shared constants — doc type, doc_flow node/edge names, and the number-range object. This
 * slice ships the `shipment` (선적) backbone of the 4PL logistics domain. Mirrors trade-compliance.constants /
 * sales.constants. Naming follows the established split: doc_flow node types use the FULL domain snake
 * (`logistics_4pl.*`, like `trade_compliance.export_declaration`); the number-range object uses the SHORT
 * namespace (`logistics.*`, like `trade.export_declaration`).
 */

/** Document type (SAP BLART/essence) owned by the shipment. 'SH' / 'SH-' kept aligned (like ED/IM/DD). */
export const DOC_TYPE_SHIPMENT = 'SH';

/** doc_flow node type (§4.3) — the shipment header (item-granularity edges are not written). */
export const DOC_FLOW_TYPE_SHIPMENT = 'logistics_4pl.shipment';

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

/** Number-range object (SAP Number Range) — global-scoped, like the ED-/IM-/DD- ranges. doc_no = SH-NNNNNN. */
export const NUMBER_OBJECT_SHIPMENT = 'logistics.shipment';
