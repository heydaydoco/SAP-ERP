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
  /** Subledger partner — REQUIRED when `glAccount` is a reconciliation account (AR/AP). */
  partnerId?: string;
  /** CO object; the posting service allows it on P&L (revenue/expense) lines only. */
  costCenterId?: string;
  /** Tax code that produced a VAT line; the computed amount is frozen on the line. */
  taxCode?: string;
  lineText?: string;
}

export interface CurrencyTotals {
  debit: Money;
  credit: Money;
}

/** A line carrying its functional-currency amount — the FX translation of the document `money`. */
export interface FunctionalLine {
  drCr: DrCr;
  /** This line's amount translated into the company's functional (local) currency. */
  functionalAmount: Money;
}

/** Tally debits/credits per currency over any line shape, given how to read its side and amount. */
function totalsBy<T>(
  lines: readonly T[],
  amountOf: (line: T) => Money,
  sideOf: (line: T) => DrCr,
): Map<string, CurrencyTotals> {
  const totals = new Map<string, CurrencyTotals>();
  for (const line of lines) {
    const money = amountOf(line);
    let entry = totals.get(money.currency);
    if (!entry) {
      const zero = money.withMinorUnits(0n);
      entry = { debit: zero, credit: zero };
      totals.set(money.currency, entry);
    }
    if (sideOf(line) === 'D') entry.debit = entry.debit.add(money);
    else entry.credit = entry.credit.add(money);
  }
  return totals;
}

/** Total debits and credits per document currency. */
export function sumByCurrency(lines: readonly PostingLine[]): Map<string, CurrencyTotals> {
  return totalsBy(
    lines,
    (l) => l.money,
    (l) => l.drCr,
  );
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

/**
 * Throw unless the entry balances in its functional currency (Σdebit == Σcredit per functional
 * currency). The FX counterpart of {@link assertBalanced}: a cross-currency entry balances in the
 * document currency by construction, but per-line translation + rounding can drift the functional
 * sums by a few minor units — fi-posting injects an FX_ROUNDING line to close that gap and calls
 * this to prove the tie-out before writing (the migration-0009 DB trigger re-checks it at COMMIT).
 */
export function assertFunctionalBalanced(lines: readonly FunctionalLine[]): void {
  if (lines.length < 2) {
    throw new Error('a journal entry needs at least two lines');
  }
  for (const [currency, { debit, credit }] of totalsBy(
    lines,
    (l) => l.functionalAmount,
    (l) => l.drCr,
  )) {
    if (!debit.equals(credit)) {
      throw new Error(
        `functionally unbalanced in ${currency}: ` +
          `debit ${debit.toDecimal()} != credit ${credit.toDecimal()}`,
      );
    }
  }
}
