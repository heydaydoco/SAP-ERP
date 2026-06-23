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

// ── import-declaration (수입신고) — the symmetric IMPORT leg ──────────────────────────────────────────

/**
 * Document type owned by the import declaration. 'IM' (not 'ID') — the doc_type and the doc_no prefix
 * stay aligned ('IM' / 'IM-'), and 'ID' reads as an identifier. Symmetric to export's 'ED' / 'ED-'.
 */
export const DOC_TYPE_IMPORT_DECLARATION = 'IM';

/** doc_flow node type (§4.3) — the import declaration header. */
export const DOC_FLOW_TYPE_IMPORT_DECLARATION = 'trade_compliance.import_declaration';

/**
 * doc_flow node type for the import GOODS RECEIPT (the physical lineage target) — the 수입 GR IS a 101
 * goods_movement. Value EQUALS `DOC_FLOW_TYPE_DELIVERY` ('inventory.goods_movement') — both a 601 GI and a
 * 101 GR are goods_movement nodes; the distinct name documents that the import leg anchors to a RECEIPT.
 *
 * The import declaration writes the ONLY doc_flow edge that TARGETS this goods_movement node: the GR's own
 * `RECEIVES` edges are sourced FROM its lines TO the PO, and landed cost's `CAPITALIZES` edges target the
 * PO item (`procurement.purchase_order_item`) — neither points AT the goods_movement node. It is still the
 * same PHYSICAL receipt whose inventory VALUE landed cost capitalizes (the FI/valuation sense) — the mirror
 * of export's `DECLARES`→601 GI. Referenced as a PLAIN STRING target (no FK, no cross-domain import).
 *
 * Why the GR and NOT the import invoice / landed cost: 수입신고 is filed against the physically received
 * goods (입항 → 보세반입 → 신고 → 수리 → 반출); the GR always exists at 신고 time. Anchoring to the GR (not
 * landed cost) keeps the declaration's lineage independent of whether landed cost has posted yet — one
 * physical truth, two non-overlapping concerns (legal record vs FI capitalization).
 */
export const DOC_FLOW_TYPE_GOODS_RECEIPT = 'inventory.goods_movement';

/** The 수입 GR movement type (SAP 101 priced goods receipt) the declaration must anchor to. */
export const GR_MOVEMENT_TYPE = '101';

/**
 * doc_flow relationship: an import declaration DECLARES the 수입 GR (101 receipt) it is filed against —
 * newer document → the earlier physical document it derives from. Reuses the `DECLARES` edge kind (export
 * → 601 GI symmetry). NOT a POSTS edge (the declaration owns no journal). Direction: import_declaration → GR.
 */
// REL_DECLARES (above) is reused for the import → GR edge.

/** Number-range object — global-scoped, like the ED- range. doc_no = IM-NNNNNN. */
export const NUMBER_OBJECT_IMPORT_DECLARATION = 'trade.import_declaration';
