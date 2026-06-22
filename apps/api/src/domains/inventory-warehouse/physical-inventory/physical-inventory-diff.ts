import { formatScaled6, parseScaled6 } from '../inventory/map.js';
import { MOVEMENT_TYPE_PI_GAIN, MOVEMENT_TYPE_PI_LOSS } from './physical-inventory.constants.js';

/**
 * Physical-inventory difference math — pure functions (root CLAUDE.md §5.4: calculation logic gets
 * mandatory unit tests; wrong math = wrong money). Quantities are exact scale-6 fixed-point bigints
 * (mirroring the DB `NUMERIC(18,6)` columns), reusing the MAP codec in `inventory/map.ts`. The
 * VALUE of an adjustment is NOT computed here — it is the engine's `valueAtAverage` against the
 * current MAP; this module only decides direction + magnitude (701 gain / 702 loss / none) from the
 * counted difference.
 */

/** Format a SIGNED scale-6 bigint (`diff_qty` may be negative for a loss) to its NUMERIC(18,6) string. */
export function formatSignedScaled6(value: bigint): string {
  return value < 0n ? `-${formatScaled6(-value)}` : formatScaled6(value);
}

/** Parse a SIGNED scale-6 decimal string (e.g. `'-2.000000'`) into a bigint. */
export function parseSignedScaled6(value: string): bigint {
  const s = value.trim();
  return s.startsWith('-') ? -parseScaled6(s.slice(1)) : parseScaled6(s);
}

export interface DiffClassification {
  /** 701 when physical > book (gain), 702 when physical < book (loss). */
  movementType: typeof MOVEMENT_TYPE_PI_GAIN | typeof MOVEMENT_TYPE_PI_LOSS;
  /** The adjustment magnitude (always POSITIVE) the goods movement posts as its line qty. */
  magnitude6: bigint;
}

/**
 * Classify a counted difference: `physical − book`. Returns the adjustment movement type + positive
 * magnitude, or `null` when the count matches the book (no movement, no journal — §scope). Book and
 * physical are non-negative quantities (the count and the snapshot can each be zero).
 */
export function classifyDiff(book6: bigint, physical6: bigint): DiffClassification | null {
  if (book6 < 0n) throw new Error('book quantity must be non-negative');
  if (physical6 < 0n) throw new Error('physical quantity must be non-negative');
  const diff6 = physical6 - book6;
  if (diff6 === 0n) return null;
  return diff6 > 0n
    ? { movementType: MOVEMENT_TYPE_PI_GAIN, magnitude6: diff6 }
    : { movementType: MOVEMENT_TYPE_PI_LOSS, magnitude6: -diff6 };
}
