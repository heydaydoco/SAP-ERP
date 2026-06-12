/**
 * Import-GR valuation math — pure functions (root CLAUDE.md §5.4: calculation logic gets mandatory
 * unit tests; wrong math = wrong money). A foreign (import) PO carries its unit price in the order
 * currency; the goods-movement engine values stock ONLY in the functional currency (the
 * `material_valuation` KRW invariant). So the GR orchestrator translates the foreign unit price to a
 * functional-currency unit price at the GR-date 'M' rate BEFORE handing it to the engine (Option P:
 * KRW in → KRW out, engine unchanged).
 *
 * Unit prices are exact **scale-6 fixed-point bigints** mirroring `NUMERIC(18,6)` (same as the MAP
 * math, `inventory/map.ts`). The 'M' rate is the `fx_rate` master scale, `NUMERIC(18,6)`. Translating
 * a rate (price) by a rate (fx) stays at scale 6 and is independent of either currency's minor unit
 * — the engine later rounds qty × price to the functional minor unit when it values the receipt.
 */

const FX_RATE_SCALE = 6;
const RATE_ONE = 10n ** BigInt(FX_RATE_SCALE);
const RATE_RE = /^\d{1,12}(\.\d{1,6})?$/;

/** `num / den` rounded half away from zero. `den` must be positive; `num` may be negative. */
function divRoundHalfAway(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error('divRoundHalfAway: denominator must be positive');
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const rounded = (abs * 2n + den) / (den * 2n);
  return negative ? -rounded : rounded;
}

/** Parse a scale-6 'M' fx rate string into a positive scale-6 bigint. */
export function parseRate6(rate: string): bigint {
  const str = rate.trim();
  if (!RATE_RE.test(str)) throw new Error(`invalid fx rate: "${rate}"`);
  const [intPart = '0', fracPart = ''] = str.split('.');
  const r = BigInt(intPart + fracPart.padEnd(FX_RATE_SCALE, '0'));
  if (r <= 0n) throw new Error(`fx rate must be positive: "${rate}"`);
  return r;
}

/**
 * Translate a FOREIGN scale-6 unit price into the functional currency at a scale-6 'M' rate, staying
 * at scale 6 and rounded half away from zero:
 *
 *   functional6 = round_half_away( foreign6 · rate6 / 10^6 )
 *
 * The GR passes the result to the (functional-currency-only) goods-movement engine, which values the
 * receipt at qty × functional price — the import GR's KRW basis at the GR-date rate. The engine's own
 * `receiptValue` rounds that product to the functional minor unit, so stock_value stays exact and the
 * inventory↔GL invariant is untouched.
 */
export function functionalUnitPrice6(foreignPrice6: bigint, rate: string): bigint {
  if (foreignPrice6 < 0n) throw new Error('unit price must be non-negative');
  return divRoundHalfAway(foreignPrice6 * parseRate6(rate), RATE_ONE);
}
