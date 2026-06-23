import { Money, type CurrencyRegistry } from '@erp/kernel';
import type { CurrencyCode } from '@erp/shared';

/**
 * Import-declaration math (§5.4 mandatory calc test) — a pure, currency-aware module separate from the
 * service. A 수입신고 posts NOTHING to FI (landed cost owns import accounting), but its declared values must
 * still be EXACT and consistency-checkable. All amounts go through the kernel `Money` value object (integer
 * minor units, per-currency exponent from the registry) — never a float, never a hard-coded "2 cents".
 *
 *  - `sumCustomsValues`   Σ line 과세가격, for the G3a header-vs-lines consistency check. `Money.of` REJECTS a
 *                         line amount with finer precision than the declaration currency allows (the caller
 *                         maps that to a 400), exactly like export's FOB sum. Returns a NUMERIC(18,4) string.
 *  - `expectedDutyAmount` Σ (line 과세가격 × 관세율%) via `Money.percentage` (the one place rate rounding lives,
 *                         half-away) — the G3b estimate; estimable only when EVERY line declares a rate.
 *  - `amountsMatch`       exact minor-unit equality of two NUMERIC(18,4) strings (G3a).
 *  - `dutyWithinTolerance` |declared − expected| ≤ 1% of |expected| (G3b — a coarse "크게 어긋남" INFO check).
 *
 * The comparison helpers take CANONICAL NUMERIC(18,4) strings (e.g. `Money.toNumeric()` output, '1500.0000'
 * even for KRW), so they parse with `Money.fromNumeric` (lenient on trailing zeros, strict on sub-minor-unit
 * residue) — never `Money.of`, which rejects KRW '1500.0000'.
 */

export interface CustomsValueLine {
  /** 1-based line number, for error attribution. */
  lineNo: number;
  /** Line 과세가격 (customs value) as a decimal string (declaration currency, natural scale). */
  customsValue: string;
}

/**
 * Sum line customs values into the declaration total, returned as a `NUMERIC(18,4)` string. Empty input is
 * `0.0000`. Throws (with the offending line number) if a line amount is invalid for `currency`.
 */
export function sumCustomsValues(
  lines: readonly CustomsValueLine[],
  currency: CurrencyCode,
  registry?: CurrencyRegistry,
): string {
  let total = Money.zero(currency, registry);
  for (const line of lines) {
    let lineMoney: Money;
    try {
      lineMoney = Money.of(line.customsValue, currency, registry);
    } catch (err) {
      throw new Error(
        `line ${line.lineNo}: invalid customs value "${line.customsValue}" for ${currency} — ${(err as Error).message}`,
      );
    }
    total = total.add(lineMoney);
  }
  return total.toNumeric();
}

export interface DutyLine {
  /** Line 과세가격 (customs value), declaration currency (natural scale). */
  customsValue: string;
  /** 관세율 (%) as a decimal string, or null when not declared on the line. */
  dutyRate: string | null;
}

/**
 * Estimate the declared duty as Σ (line 과세가격 × 관세율%), through `Money.percentage` (per-currency
 * half-away rounding). Returns `null` — NOT estimable — when ANY line omits its duty rate (the estimate
 * would be biased low). A 0% line (e.g. FTA 특혜) contributes nothing. Result is a `NUMERIC(18,4)` string.
 */
export function expectedDutyAmount(
  lines: readonly DutyLine[],
  currency: CurrencyCode,
  registry?: CurrencyRegistry,
): string | null {
  if (lines.some((l) => l.dutyRate == null)) return null;
  let total = Money.zero(currency, registry);
  for (const line of lines) {
    const base = Money.of(line.customsValue, currency, registry);
    total = total.add(base.percentage(String(line.dutyRate)));
  }
  return total.toNumeric();
}

/** Exact minor-unit equality of two NUMERIC(18,4) amounts in the same currency (G3a header-vs-lines). */
export function amountsMatch(
  a: string,
  b: string,
  currency: CurrencyCode,
  registry?: CurrencyRegistry,
): boolean {
  return Money.fromNumeric(a, currency, registry).equals(Money.fromNumeric(b, currency, registry));
}

/**
 * G3b tolerance: |declared − expected| ≤ 1% of |expected| (minor units, exact bigint). When expected is 0,
 * within tolerance iff declared is 0 too. A coarse, deterministic "크게 어긋나지 않음" test — its negation
 * drives a SOFT INFO note, never a block. Both args are canonical NUMERIC(18,4) strings.
 */
export function dutyWithinTolerance(
  declared: string,
  expected: string,
  currency: CurrencyCode,
  registry?: CurrencyRegistry,
): boolean {
  const d = Money.fromNumeric(declared, currency, registry).minorUnits;
  const e = Money.fromNumeric(expected, currency, registry).minorUnits;
  const absE = e < 0n ? -e : e;
  if (absE === 0n) return d === 0n;
  const diff = d > e ? d - e : e - d;
  return diff * 100n <= absE;
}
