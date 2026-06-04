import { Money } from '@erp/kernel';

/**
 * VAT (부가세) amount for a base at `ratePercent` percentage points. Delegates to the kernel `Money`
 * rounding so the tax line is rounded to the base currency's minor unit exactly once (root CLAUDE.md
 * §5.4 — tax math is mandatory-tested). Returns Money in the same currency as `base`.
 */
export function computeTax(base: Money, ratePercent: string): Money {
  return base.percentage(ratePercent);
}
