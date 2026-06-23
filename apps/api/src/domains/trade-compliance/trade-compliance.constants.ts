/**
 * Trade-compliance (SAP GTS) shared constants — doc types, doc_flow node/edge names, and number-range
 * objects. This slice ships the `export-declaration` (수출신고) subject of the `customs-declaration`
 * module. Mirrors sales.constants / procurement.constants.
 */

/** Document type (SAP BLART/essence) owned by the export declaration. */
export const DOC_TYPE_EXPORT_DECLARATION = 'ED';

/** doc_flow node type (§4.3) — the declaration header (item-granularity edges are not written yet). */
export const DOC_FLOW_TYPE_EXPORT_DECLARATION = 'trade_compliance.export_declaration';

/**
 * doc_flow node type for the export DELIVERY (the physical lineage target) — a delivery IS a 601 goods
 * issue: the O2C delivery wrapper adopts the GI's `GM-<year>` doc_no (§10), and `inventory.goods_movement`
 * is the existing doc_flow node the O2C slice writes its `DELIVERS` edges from (goods_movement → SO). So
 * the export declaration hangs off the SAME physical node. Value matches `inventory.goods_movement`;
 * referenced as a PLAIN STRING target — the doc_flow graph is generic (no FK, no cross-domain module import).
 *
 * Why the delivery and NOT the billing: trade practice files 수출신고 BEFORE the commercial invoice
 * (보세반입 → 신고 → 수리 → 선적). Hanging the edge on billing would imply "no invoice → no 수출신고",
 * which reverses real practice; the delivery/GI always exists at 신고 time (출고 없이 수출 없음), so it is
 * the physically safe and accurate lineage anchor. The 영세율 / billing tax-consistency is a SEPARATE
 * read-only gate (see export-declaration-warnings), never a doc_flow edge.
 */
export const DOC_FLOW_TYPE_DELIVERY = 'inventory.goods_movement';

/**
 * doc_flow relationship: an export declaration DECLARES the delivery (601 export GI) it ships — newer
 * document → the earlier physical document it derives from (like billing —BILLS→ SO, GI —DELIVERS→ SO).
 * NOT a POSTS edge (the declaration owns no journal). Direction: export_declaration → delivery(GI).
 */
export const REL_DECLARES = 'DECLARES';

/** Number-range object (SAP Number Range) — global-scoped, like the SO/PO ranges. doc_no = ED-NNNNNN. */
export const NUMBER_OBJECT_EXPORT_DECLARATION = 'trade.export_declaration';
