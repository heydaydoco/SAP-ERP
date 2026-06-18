/**
 * Open-quantity math (root CLAUDE.md §5.4 — wrong math = wrong stock/money). Pure scale-6 bigint
 * arithmetic mirroring the GR over-delivery / IV over-invoice running-map guard, shared by the O2C
 * delivery and billing services:
 *   - delivery (open-to-deliver): limit = SO ordered qty, prior = Σ already delivered (DELIVERS edges)
 *   - billing  (open-to-bill):    limit = Σ delivered qty, prior = Σ already billed (BILLS, reversal-aware)
 * `running` accumulates the quantities of earlier lines in the SAME document so two lines on one SO item
 * cannot each slip past by checking the pre-document aggregate alone (the §ProcurementQuery pattern).
 */

/** Remaining open quantity = limit − prior − running, clamped at ≥ 0 (scale-6 bigints). */
export function openQty6(limit6: bigint, prior6: bigint, running6: bigint): bigint {
  const open = limit6 - prior6 - running6;
  return open < 0n ? 0n : open;
}

/** True iff `requested6` exceeds the open quantity (limit − prior − running). */
export function exceedsOpen(
  limit6: bigint,
  prior6: bigint,
  running6: bigint,
  requested6: bigint,
): boolean {
  return prior6 + running6 + requested6 > limit6;
}
