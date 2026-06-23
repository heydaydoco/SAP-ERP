import { Money, type CurrencyRegistry } from '@erp/kernel';
import type { CurrencyCode } from '@erp/shared';

/**
 * Export-declaration FOB math (§5.4 mandatory calc test) — a pure, currency-aware module separate from the
 * service. The declaration's `total_fob_amount` is the exact sum of its line FOB amounts, computed through
 * the kernel `Money` value object (integer minor units, per-currency exponent from the registry) so it is
 * never a float and never hard-codes "2 cents". `Money.of` REJECTS a line amount with finer precision than
 * the declaration currency allows (e.g. a decimal on a KRW/JPY amount, >2 decimals on USD) — the caller
 * maps that to a 400. A declaration posts nothing to FI, but its stated value must still be exact.
 */

export interface FobLine {
  /** 1-based line number, for error attribution. */
  lineNo: number;
  /** Line FOB amount as a decimal string (declaration currency). */
  fobAmount: string;
}

/**
 * Sum line FOB amounts into the declaration total, returned as a `NUMERIC(18,4)` string. Empty input is
 * `0.0000`. Throws (with the offending line number) if a line amount is invalid for `currency`.
 */
export function sumFobAmounts(
  lines: readonly FobLine[],
  currency: CurrencyCode,
  registry?: CurrencyRegistry,
): string {
  let total = Money.zero(currency, registry);
  for (const line of lines) {
    let lineMoney: Money;
    try {
      lineMoney = Money.of(line.fobAmount, currency, registry);
    } catch (err) {
      throw new Error(
        `line ${line.lineNo}: invalid FOB amount "${line.fobAmount}" for ${currency} — ${(err as Error).message}`,
      );
    }
    total = total.add(lineMoney);
  }
  return total.toNumeric();
}
