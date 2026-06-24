import { Money, type CurrencyRegistry } from '@erp/kernel';

/**
 * Duty-drawback (관세환급, 간이정액) math (§5.4 mandatory calc test) — a pure, currency-aware module separate
 * from the service. Wrong math = wrong refund (a §5.4 cash item), so EVERY amount goes through the kernel
 * `Money` value object (exact integer minor units, per-currency exponent) — never a float, never hard-coded
 * "2 cents". The 간이정액 refund per line is:
 *
 *     line_refund(원) = round( fob_krw(원) × rate_per_10k / 10,000 )
 *
 * where `fob_krw` is the export FOB translated to KRW (auto at the 수리일 'M' rate, or a manual 원화 FOB) and
 * `rate_per_10k` is the 간이정액환급률 (원 per 10,000원 FOB). KRW minor-unit is 0, so `fob_krw.minorUnits`
 * IS 원. The rounding rule is a PARAMETER (`RefundRounding`) — the actual 관세청 규정 (원미만 절사 vs 반올림)
 * is isolated here so a confirmed rule is a one-constant change + a test flip, never a logic rewrite.
 */

/** 원 단위 rounding policy for the line refund: HALF_UP = 반올림 (away from zero); FLOOR = 원미만 절사. */
export type RefundRounding = 'HALF_UP' | 'FLOOR';

const RATE_SCALE = 4; // rate_per_10k is NUMERIC(18,4)
const RATE_RE = /^\d{1,14}(\.\d{1,4})?$/;

function pow10(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}

/** Parse a NUMERIC(18,4) 간이정액률 string into an integer scaled by 10^4. Rejects an invalid/over-precision rate. */
export function parseRatePer10k(rate: string): bigint {
  const s = rate.trim();
  if (!RATE_RE.test(s)) {
    throw new Error(`invalid rate_per_10k "${rate}" — expected non-negative NUMERIC(18,4)`);
  }
  const [intPart = '0', fracPart = ''] = s.split('.');
  return BigInt(intPart) * pow10(RATE_SCALE) + BigInt(fracPart.padEnd(RATE_SCALE, '0'));
}

/**
 * 간이정액 line refund = round( fob_krw(원) × rate_per_10k / 10,000 ), exact integer math.
 * `fobKrw` MUST be a KRW Money (minorUnits = 원). `ratePer10k` is the NUMERIC(18,4) 률 (0 ⇒ refund 0).
 * Returns a KRW Money. Rounding per `rounding` (default HALF_UP / 반올림).
 */
export function simplifiedLineRefund(
  fobKrw: Money,
  ratePer10k: string,
  rounding: RefundRounding = 'HALF_UP',
): Money {
  if (fobKrw.currency !== 'KRW') {
    throw new Error(`simplifiedLineRefund expects a KRW base, got ${fobKrw.currency}`);
  }
  const rate = parseRatePer10k(ratePer10k); // scaled ×10^4
  // refund = fobWon × (rate / 10^4) / 10,000 = fobWon × rate / 10^8
  const numer = fobKrw.minorUnits * rate;
  const denom = 10_000n * pow10(RATE_SCALE); // 10,000 (per-10k) × 10^4 (rate scale) = 10^8
  const neg = numer < 0n;
  const abs = neg ? -numer : numer;
  const q =
    rounding === 'FLOOR'
      ? abs / denom // 원미만 절사 (truncate toward zero)
      : (abs * 2n + denom) / (denom * 2n); // 반올림 (half away from zero)
  return fobKrw.withMinorUnits(neg ? -q : q);
}

/** Σ line refunds (all KRW) → the header claimed total. Empty input is 0원. */
export function sumRefunds(refunds: readonly Money[], registry?: CurrencyRegistry): Money {
  let total = Money.zero('KRW', registry);
  for (const r of refunds) total = total.add(r);
  return total;
}

/**
 * G3: does the MANUAL 원화 FOB deviate from the AUTO-converted KRW beyond the tolerance
 * max(1,000원, 1% of auto)? Both are KRW Money; exact bigint comparison (no float). "초과" = strictly above
 * BOTH bounds (so a deviation must exceed the larger of the two). Used only when a line provides a manual
 * fob_krw AND the auto value is computable (the source currency has a 수리일 'M' rate).
 */
export function manualFobDeviationExceeds(manualKrw: Money, autoKrw: Money): boolean {
  if (manualKrw.currency !== 'KRW' || autoKrw.currency !== 'KRW') {
    throw new Error('manualFobDeviationExceeds expects KRW amounts');
  }
  const m = manualKrw.minorUnits;
  const a = autoKrw.minorUnits;
  const diff = m > a ? m - a : a - m;
  const absAuto = a < 0n ? -a : a;
  // diff > max(1,000, 1% of auto)  ⟺  diff > 1,000  AND  diff*100 > |auto|
  return diff > 1_000n && diff * 100n > absAuto;
}
