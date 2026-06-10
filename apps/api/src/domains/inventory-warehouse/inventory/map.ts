import { Money } from '@erp/kernel';

/**
 * Moving-average-price (MAP) valuation math — pure functions (root CLAUDE.md §5.4: calculation
 * logic gets mandatory unit tests; wrong math = wrong money).
 *
 * Quantities are exact **scale-6 fixed-point bigints** mirroring the DB `NUMERIC(18,6)`
 * quantity columns; unit prices use the same scale-6 representation. Values are kernel `Money`
 * (exact integer minor units) — every journal amount equals a `stock_value` delta computed here,
 * rounded half away from zero to the currency's minor unit, so the GL and the valuation anchor
 * can never drift (the reconciliation invariant).
 *
 * The moving average price itself is DERIVED (`stock_value / valuation_qty`): kernel `Money` has
 * no division by design, so the price is computed here as a scale-6 decimal for persistence and
 * issue pricing — the value anchor is never recomputed FROM the stored price.
 */

export const QTY_SCALE = 6;

const SCALED_RE = /^\d{1,12}(\.\d{1,6})?$/;

function pow10(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}

const QTY_ONE = pow10(QTY_SCALE);

/** `num / den` rounded half away from zero. `den` must be positive; `num` may be negative. */
function divRoundHalfAway(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error('divRoundHalfAway: denominator must be positive');
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const rounded = (abs * 2n + den) / (den * 2n);
  return negative ? -rounded : rounded;
}

/**
 * Parse a non-negative decimal string (≤6 fraction digits — the `NUMERIC(18,6)` shape quantities
 * and unit prices come in from DTOs and the DB) into a scale-6 bigint.
 */
export function parseScaled6(value: string): bigint {
  const str = value.trim();
  if (!SCALED_RE.test(str)) {
    throw new Error(`invalid quantity/price: "${value}" (non-negative, max 6 decimals)`);
  }
  const [intPart = '0', fracPart = ''] = str.split('.');
  return BigInt(intPart) * QTY_ONE + BigInt(fracPart.padEnd(QTY_SCALE, '0') || '0');
}

/** Format a scale-6 bigint back to its canonical `NUMERIC(18,6)` string (e.g. `'10.000000'`). */
export function formatScaled6(value: bigint): string {
  if (value < 0n) throw new Error('quantities are non-negative');
  const abs = value.toString().padStart(QTY_SCALE + 1, '0');
  const cut = abs.length - QTY_SCALE;
  return `${abs.slice(0, cut)}.${abs.slice(cut)}`;
}

/**
 * Value of a PRICED receipt (561 initial load / 101 direct GR): `qty × unitPrice`, rounded half
 * away from zero to the currency's minor unit. `zero` supplies the currency + exponent (a
 * `Money.zero` of the valuation currency) so this stays registry-free and pure.
 */
export function receiptValue(qty6: bigint, unitPrice6: bigint, zero: Money): Money {
  if (qty6 <= 0n) throw new Error('receipt quantity must be positive');
  if (unitPrice6 < 0n) throw new Error('unit price must be non-negative');
  // minor = qty6/10^6 · price6/10^6 · 10^e  =  qty6·price6·10^e / 10^12
  const minor = divRoundHalfAway(qty6 * unitPrice6 * pow10(zero.minorUnit), QTY_ONE * QTY_ONE);
  return zero.withMinorUnits(minor);
}

/**
 * Value of a movement at the CURRENT moving average (201/711 issues, 712 surplus): the exact
 * proportional share `stockValue × qty / stockQty`, rounded half away to the minor unit — i.e.
 * `qty × MAP` against the UNROUNDED average, so no double rounding through the stored price.
 * A full issue (`qty == stockQty`) returns the entire remaining value: the stock empties to
 * exactly zero value, never leaving an orphaned rounding residue on zero quantity.
 *
 * `allowExceed` distinguishes the two callers. Issues (201/711) leave it false: `qty > stockQty`
 * is an over-issue and the formula would value more than exists, so it throws (the service guards
 * issues first; this is the defensive backstop). A **712 surplus** sets it true — a physical count
 * finding MORE than the book quantity (book 2, count +5) is legitimate, and `stockValue × qty /
 * stockQty` stays MAP-neutral for any positive qty.
 */
export function valueAtAverage(
  qty6: bigint,
  stockQty6: bigint,
  stockValue: Money,
  allowExceed = false,
): Money {
  if (qty6 <= 0n) throw new Error('movement quantity must be positive');
  if (stockQty6 <= 0n) throw new Error('no stock quantity to derive a moving average from');
  if (!allowExceed && qty6 > stockQty6) throw new Error('quantity exceeds the valuated stock');
  if (qty6 === stockQty6) return stockValue;
  return stockValue.withMinorUnits(divRoundHalfAway(stockValue.minorUnits * qty6, stockQty6));
}

/**
 * Derived moving average price at scale 6: `value / qty`, rounded half away from zero.
 * Zero quantity yields 0 — but issues never call this (MAP is invariant on issues; the last
 * average survives an emptied stock, SAP VERPR behavior).
 */
export function averagePrice6(qty6: bigint, value: Money): bigint {
  if (qty6 < 0n) throw new Error('quantity must be non-negative');
  if (qty6 === 0n) return 0n;
  // price6 = (minor/10^e) / (qty6/10^6) · 10^6  =  minor · 10^12 / (10^e · qty6)
  return divRoundHalfAway(value.minorUnits * QTY_ONE * QTY_ONE, pow10(value.minorUnit) * qty6);
}
