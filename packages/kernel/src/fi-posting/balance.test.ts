import { describe, it, expect } from 'vitest';
import {
  isBalanced,
  assertBalanced,
  assertFunctionalBalanced,
  sumByCurrency,
  type FunctionalLine,
  type PostingLine,
} from './balance';
import { Money } from '../money/money';

// Example unit test for the test toolchain (root CLAUDE.md §5.4: calculation logic is mandatory).
// fi-posting balance is the canonical "wrong math = wrong money" calculation — now currency-aware.

describe('fi-posting/balance', () => {
  // A KRW SD-billing entry: (Dr) AR 11,000 / (Cr) sales 10,000 + output VAT 1,000.
  const krwBilling: PostingLine[] = [
    { glAccount: '108', drCr: 'D', money: Money.of('11000', 'KRW') },
    { glAccount: '401', drCr: 'C', money: Money.of('10000', 'KRW') },
    { glAccount: '255', drCr: 'C', money: Money.of('1000', 'KRW') },
  ];

  it('sums debits and credits per currency in minor units', () => {
    const totals = sumByCurrency(krwBilling);
    expect(totals.get('KRW')?.debit.minorUnits).toBe(11000n);
    expect(totals.get('KRW')?.credit.minorUnits).toBe(11000n);
  });

  it('recognises a balanced KRW entry', () => {
    expect(isBalanced(krwBilling)).toBe(true);
    expect(() => assertBalanced(krwBilling)).not.toThrow();
  });

  it('rejects an unbalanced entry', () => {
    const bad: PostingLine[] = [
      { glAccount: '108', drCr: 'D', money: Money.of('110', 'USD') },
      { glAccount: '401', drCr: 'C', money: Money.of('100', 'USD') },
    ];
    expect(isBalanced(bad)).toBe(false);
    expect(() => assertBalanced(bad)).toThrow(/unbalanced entry in USD/);
  });

  it('balances each currency independently', () => {
    const multi: PostingLine[] = [
      { glAccount: 'a', drCr: 'D', money: Money.of('1.50', 'USD') },
      { glAccount: 'b', drCr: 'C', money: Money.of('1.50', 'USD') },
      { glAccount: 'c', drCr: 'D', money: Money.of('2000', 'KRW') },
      { glAccount: 'd', drCr: 'C', money: Money.of('2000', 'KRW') },
    ];
    expect(isBalanced(multi)).toBe(true);
  });

  it('avoids float drift across many small lines (USD cents)', () => {
    const lines: PostingLine[] = [
      { glAccount: 'x', drCr: 'D', money: Money.of('0.10', 'USD') },
      { glAccount: 'x', drCr: 'D', money: Money.of('0.20', 'USD') },
      { glAccount: 'y', drCr: 'C', money: Money.of('0.30', 'USD') },
    ];
    expect(isBalanced(lines)).toBe(true); // 0.1 + 0.2 !== 0.3 in float, exact in minor units
  });

  it('requires at least two lines', () => {
    const one: PostingLine[] = [{ glAccount: 'x', drCr: 'D', money: Money.of('1.00', 'USD') }];
    expect(() => assertBalanced(one)).toThrow(/two lines/);
  });
});

// assertFunctionalBalanced is the FX tie-out (root CLAUDE.md §5.4): Σdr == Σcr in the local currency.
describe('fi-posting/assertFunctionalBalanced', () => {
  // A USD invoice translated to KRW @1350: Dr AR 148,500 / Cr revenue 135,000 + output VAT 13,500.
  const fxBilling: FunctionalLine[] = [
    { drCr: 'D', functionalAmount: Money.of('148500', 'KRW') },
    { drCr: 'C', functionalAmount: Money.of('135000', 'KRW') },
    { drCr: 'C', functionalAmount: Money.of('13500', 'KRW') },
  ];

  it('accepts a functionally balanced entry', () => {
    expect(() => assertFunctionalBalanced(fxBilling)).not.toThrow();
  });

  it('rejects a functional drift of even one minor unit', () => {
    const drifted: FunctionalLine[] = [
      { drCr: 'D', functionalAmount: Money.of('135001', 'KRW') },
      { drCr: 'C', functionalAmount: Money.of('135000', 'KRW') },
    ];
    expect(() => assertFunctionalBalanced(drifted)).toThrow(/functionally unbalanced in KRW/);
  });

  it('requires at least two lines', () => {
    const one: FunctionalLine[] = [{ drCr: 'D', functionalAmount: Money.of('1', 'KRW') }];
    expect(() => assertFunctionalBalanced(one)).toThrow(/two lines/);
  });
});
