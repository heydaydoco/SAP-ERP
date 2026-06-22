/**
 * Physical-inventory (재고 실사) shared constants — doc type, movement types, the IDI offset key,
 * doc_flow node/edge names, and the number-range object. Mirrors sales.constants / procurement.constants.
 */

/** Document type (SAP BLART/essence) owned by the physical-inventory count document. */
export const DOC_TYPE_PHYSICAL_INVENTORY = 'PI';

/**
 * Physical-inventory adjustment movement types (the engine's IN-list was widened to admit them):
 *   701 stock GAIN  (physical > book) — a 712-style surplus valued at the current MAP (Dr BSX / Cr IDI)
 *   702 stock LOSS  (physical < book) — a 201/711-style issue valued at the current MAP (Dr IDI / Cr BSX)
 */
export const MOVEMENT_TYPE_PI_GAIN = '701';
export const MOVEMENT_TYPE_PI_LOSS = '702';

/**
 * account_determination transaction key for the inventory-difference offset (재고조정손익 → 5910). A
 * SINGLE WILDCARD rule (no valuation class) — one account holds both directions; the BSX (stock) leg
 * still resolves per valuation class. Passed as `GoodsMovementPostOptions.offsetKey` so the engine
 * routes the offset to IDI instead of GBB. Never hard-coded (§4.5) — a missing rule aborts the
 * adjustment atomically.
 */
export const IDI_KEY = 'IDI';

/** doc_flow node type for the physical-inventory count document (§4.3). */
export const DOC_FLOW_TYPE_PI = 'inventory.physical_inventory_doc';

/**
 * doc_flow relationship: a goods movement ADJUSTS the physical-inventory document that authorized it
 * (the same convention as a GR RECEIVES its PO — the movement is the source). The engine writes this
 * edge FROM the movement onto the PI doc in the movement's own tx, so the lineage exists iff the
 * adjustment does (§5.2). NEW rel_type (existing: POSTS/RECEIVES/INVOICES/DELIVERS/BILLS/CLEARS/REVERSES).
 */
export const REL_ADJUSTS = 'ADJUSTS';

/** Number-range object (SAP Number Range) — global-scoped, like SO-/BL- (the count doc is a header doc). */
export const NUMBER_OBJECT_PI = 'inventory.physical_inventory';
