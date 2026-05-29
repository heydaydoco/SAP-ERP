import { describe, it, expect } from 'vitest';
import { toCents, isBalanced, assertBalanced, sumByDrCr, type PostingLine } from './balance.js';

// Example unit test for the test toolchain (root CLAUDE.md §5.4: calculation logic is mandatory).
// fi-posting balance is the canonical "wrong math = wrong money" calculation.

describe('fi-posting/balance', () => {
  describe('toCents', () => {
    it('parses whole and fractional money strings to integer cents', () => {
      expect(toCents('0')).toBe(0n);
      expect(toCents('100')).toBe(10_000n);
      expect(toCents('100.5')).toBe(10_050n);
      expect(toCents('100.50')).toBe(10_050n);
      expect(toCents('1234567890123456.99')).toBe(123_456_789_012_345_699n);
    });

    it('rejects floats, negatives and over-scale values', () => {
      expect(() => toCents('100.001')).toThrow();
      expect(() => toCents('-5.00')).toThrow();
      expect(() => toCents('1e3')).toThrow();
      expect(() => toCents('abc')).toThrow();
    });
  });

  const balanced: PostingLine[] = [
    { glAccount: '108', drCr: 'D', amount: '110.00' }, // AR
    { glAccount: '401', drCr: 'C', amount: '100.00' }, // sales
    { glAccount: '255', drCr: 'C', amount: '10.00' }, // output VAT
  ];

  it('sums debits and credits in cents', () => {
    expect(sumByDrCr(balanced)).toEqual({ debit: 11_000n, credit: 11_000n });
  });

  it('recognises a balanced SD-billing entry (AR / sales + VAT)', () => {
    expect(isBalanced(balanced)).toBe(true);
    expect(() => assertBalanced(balanced)).not.toThrow();
  });

  it('rejects an unbalanced entry', () => {
    const bad: PostingLine[] = [
      { glAccount: '108', drCr: 'D', amount: '110.00' },
      { glAccount: '401', drCr: 'C', amount: '100.00' },
    ];
    expect(isBalanced(bad)).toBe(false);
    expect(() => assertBalanced(bad)).toThrow(/unbalanced/);
  });

  it('avoids float drift across many small lines', () => {
    const lines: PostingLine[] = [
      { glAccount: 'x', drCr: 'D', amount: '0.10' },
      { glAccount: 'x', drCr: 'D', amount: '0.20' },
      { glAccount: 'y', drCr: 'C', amount: '0.30' },
    ];
    // 0.1 + 0.2 !== 0.3 in float, but exact in cents.
    expect(isBalanced(lines)).toBe(true);
  });

  it('requires at least two lines', () => {
    expect(() => assertBalanced([{ glAccount: 'x', drCr: 'D', amount: '1.00' }])).toThrow(
      /two lines/,
    );
  });
});
