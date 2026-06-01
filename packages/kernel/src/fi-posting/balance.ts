import type { DrCr } from '@erp/shared';
import { Money } from '../money/money';

/**
 * Pure double-entry balance math (root CLAUDE.md §3.2, §5.4).
 *
 * Works on the currency-aware {@link Money} value object — amounts are exact integer minor units,
 * never floats, never assumed to be 2-decimal "cents". A journal must balance **within each
 * currency** (debits == credits per currency); mixed-currency FX entries that balance only in the
 * local currency are layered on top in Phase 2 with explicit local-currency amounts.
 */

export interface PostingLine {
  glAccount: string;
  drCr: DrCr;
  /** Non-negative money for this line. */
  money: Money;
}

export interface CurrencyTotals {
  debit: Money;
  credit: Money;
}

/** Total debits and credits per currency. */
export function sumByCurrency(lines: readonly PostingLine[]): Map<string, CurrencyTotals> {
  const totals = new Map<string, CurrencyTotals>();
  for (const line of lines) {
    const { currency } = line.money;
    let entry = totals.get(currency);
    if (!entry) {
      const zero = line.money.withMinorUnits(0n);
      entry = { debit: zero, credit: zero };
      totals.set(currency, entry);
    }
    if (line.drCr === 'D') entry.debit = entry.debit.add(line.money);
    else entry.credit = entry.credit.add(line.money);
  }
  return totals;
}

/** True iff every currency balances and there are at least two lines. */
export function isBalanced(lines: readonly PostingLine[]): boolean {
  if (lines.length < 2) return false;
  for (const { debit, credit } of sumByCurrency(lines).values()) {
    if (!debit.equals(credit)) return false;
  }
  return true;
}

/** Throw unless the entry has ≥2 lines and balances in every currency. */
export function assertBalanced(lines: readonly PostingLine[]): void {
  if (lines.length < 2) {
    throw new Error('a journal entry needs at least two lines');
  }
  for (const [currency, { debit, credit }] of sumByCurrency(lines)) {
    if (!debit.equals(credit)) {
      throw new Error(
        `unbalanced entry in ${currency}: debit ${debit.toDecimal()} != credit ${credit.toDecimal()}`,
      );
    }
  }
}
