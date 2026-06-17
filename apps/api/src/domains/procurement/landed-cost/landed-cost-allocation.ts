import { Money } from '@erp/kernel';

/**
 * Landed-cost allocation math — pure function (root CLAUDE.md §5.4: calculation logic gets mandatory
 * unit tests; wrong math = wrong money).
 *
 * `allocateByBasis` spreads ONE incidental-cost total across the received PO lines in proportion to
 * each line's basis (the GR-booked functional value = FOB-basis proxy; v1's value-proportional rule).
 * Exact integer-minor-unit largest-remainder with an ascending-line_no tie-break, so Σ shares == the
 * total EXACTLY (no float, §3.1) and the split is byte-reproducible — a later relief can reproduce it.
 *
 * (The per-line on-hand coverage split — capitalize the still-on-stock part, expense the rest to PRD —
 * is the exact proportional `stock_value × qty / qty` share, done by the goods-movement engine under
 * the valuation lock via the already-tested `valueAtAverage`; it is not duplicated here.)
 */

/** One line entering the allocation: its non-negative basis (in minor units) and its tie-break key. */
export interface AllocationLine {
  /** Allocation basis in the total's minor units — the line's received functional value (≥ 0). */
  basisMinor: bigint;
  /** Document line number — the deterministic largest-remainder tie-break (ascending). */
  lineNo: number;
}

/**
 * Allocate `total` across `lines` proportionally to `basisMinor`, returning a share per line (same
 * order) whose Σ equals `total` EXACTLY. Largest-remainder: each line gets the floor of its exact
 * share, then the leftover minor units go one-by-one to the largest fractional remainders (ties
 * broken by ascending `lineNo`, so two runs of the same input are identical).
 *
 * When every basis is 0 (e.g. a zero-priced receipt) the weights are taken equal, so the total still
 * distributes deterministically rather than collapsing onto one line.
 */
export function allocateByBasis(total: Money, lines: readonly AllocationLine[]): Money[] {
  if (total.sign < 0) throw new Error('allocation total must be non-negative');
  const n = lines.length;
  if (n === 0) return [];
  for (const l of lines) {
    if (l.basisMinor < 0n) throw new Error('allocation basis must be non-negative');
  }

  const totalMinor = total.minorUnits;
  let basisSum = 0n;
  for (const l of lines) basisSum += l.basisMinor;
  // All-zero basis ⇒ equal weights (weight 1 each, Σ = n).
  const allZero = basisSum === 0n;
  const weights = allZero ? lines.map(() => 1n) : lines.map((l) => l.basisMinor);
  const weightSum = allZero ? BigInt(n) : basisSum;

  // Floor share + fractional remainder per line.
  const floors: bigint[] = [];
  const remainders: bigint[] = [];
  let distributed = 0n;
  for (let i = 0; i < n; i++) {
    const product = totalMinor * weights[i]!;
    floors.push(product / weightSum);
    remainders.push(product % weightSum);
    distributed += floors[i]!;
  }

  // Hand out the leftover minor units to the largest remainders (tie → smaller lineNo first).
  let leftover = totalMinor - distributed; // 0 ≤ leftover < n
  const order = lines
    .map((l, i) => ({ i, rem: remainders[i]!, lineNo: l.lineNo }))
    .sort((a, b) => (a.rem === b.rem ? a.lineNo - b.lineNo : a.rem < b.rem ? 1 : -1));
  const bonus = new Array<bigint>(n).fill(0n);
  for (let k = 0; k < order.length && leftover > 0n; k++) {
    bonus[order[k]!.i] = 1n;
    leftover -= 1n;
  }

  return floors.map((f, i) => total.withMinorUnits(f + bonus[i]!));
}
