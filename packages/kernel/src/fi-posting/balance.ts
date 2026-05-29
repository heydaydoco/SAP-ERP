import type { DrCr } from '@erp/shared';

/**
 * Pure double-entry balance math (root CLAUDE.md §3.2, §5.4).
 *
 * Money is `NUMERIC(18,2)` carried as a decimal string. We convert to integer **cents** (bigint)
 * so there is never any floating-point drift — wrong math here = wrong money.
 */

export interface PostingLine {
  glAccount: string;
  drCr: DrCr;
  /** Always non-negative money string, NUMERIC(18,2). */
  amount: string;
}

const MONEY_RE = /^\d{1,16}(\.\d{1,2})?$/;

/** Convert a non-negative NUMERIC(18,2) money string to integer cents. Throws on bad input. */
export function toCents(amount: string): bigint {
  if (!MONEY_RE.test(amount)) {
    throw new Error(`invalid money amount: "${amount}" (expected non-negative NUMERIC(18,2))`);
  }
  const [intPart = '0', fracPart = ''] = amount.split('.');
  return BigInt(intPart) * 100n + BigInt(fracPart.padEnd(2, '0'));
}

/** Sum debits and credits (in cents) over the lines. */
export function sumByDrCr(lines: readonly PostingLine[]): { debit: bigint; credit: bigint } {
  let debit = 0n;
  let credit = 0n;
  for (const line of lines) {
    const cents = toCents(line.amount);
    if (line.drCr === 'D') debit += cents;
    else credit += cents;
  }
  return { debit, credit };
}

/** True iff total debits equal total credits (a balanced entry). */
export function isBalanced(lines: readonly PostingLine[]): boolean {
  const { debit, credit } = sumByDrCr(lines);
  return debit === credit;
}

/** Throw unless the entry is balanced and has at least two lines. */
export function assertBalanced(lines: readonly PostingLine[]): void {
  if (lines.length < 2) {
    throw new Error('a journal entry needs at least two lines');
  }
  const { debit, credit } = sumByDrCr(lines);
  if (debit !== credit) {
    throw new Error(`unbalanced entry: debit ${debit} cents != credit ${credit} cents`);
  }
}
