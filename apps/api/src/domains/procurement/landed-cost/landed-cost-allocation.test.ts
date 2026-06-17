import { describe, expect, it } from 'vitest';
import { Money } from '@erp/kernel';
import { allocateByBasis, type AllocationLine } from './landed-cost-allocation.js';

/**
 * §5.4 mandatory calc tests for landed-cost allocation. The load-bearing invariant: Σ shares ==
 * the total EXACTLY (never float), with a deterministic largest-remainder + ascending-line_no
 * tie-break so a relief could reproduce the same split.
 */
describe('allocateByBasis', () => {
  const krw = (v: string) => Money.of(v, 'KRW'); // 0 decimals — minor unit = whole won
  const usd = (v: string) => Money.of(v, 'USD'); // 2 decimals — minor unit = cents
  const line = (basisMinor: bigint, lineNo: number): AllocationLine => ({ basisMinor, lineNo });
  const sum = (ms: Money[], zero: Money) => ms.reduce((s, m) => s.add(m), zero);

  it('returns [] for no lines', () => {
    expect(allocateByBasis(krw('1000'), [])).toEqual([]);
  });

  it('gives the whole total to a single line', () => {
    const out = allocateByBasis(krw('777'), [line(5n, 1)]);
    expect(out.map((m) => m.toNumeric())).toEqual(['777.0000']);
  });

  it('splits exactly proportionally when the basis divides evenly', () => {
    const out = allocateByBasis(krw('1000'), [line(100n, 1), line(200n, 2), line(700n, 3)]);
    expect(out.map((m) => m.toNumeric())).toEqual(['100.0000', '200.0000', '700.0000']);
    expect(sum(out, krw('0')).toNumeric()).toBe('1000.0000');
  });

  it('distributes the rounding remainder to the largest remainders (KRW, 0dp)', () => {
    // 1000 / 3 equal weights = 333.33 each → floors 333,333,333 (=999); 1 leftover.
    // All remainders equal ⇒ tie broken by ascending line_no → line 1 absorbs the extra won.
    const out = allocateByBasis(krw('1000'), [line(1n, 1), line(1n, 2), line(1n, 3)]);
    expect(out.map((m) => m.toNumeric())).toEqual(['334.0000', '333.0000', '333.0000']);
    expect(sum(out, krw('0')).toNumeric()).toBe('1000.0000');
  });

  it('routes a unit to the strictly-larger remainder before any tie-break (USD, 2dp)', () => {
    // $10.00 = 1000¢ across weights 1:2 → floors 333,666 (=999); leftover 1.
    // remainders 1 and 2 → the 2/3 line (larger remainder) takes the extra cent.
    const out = allocateByBasis(usd('10.00'), [line(1n, 1), line(2n, 2)]);
    expect(out.map((m) => m.toNumeric())).toEqual(['3.3300', '6.6700']);
    expect(sum(out, usd('0')).toDecimal()).toBe('10.00');
  });

  it('falls back to an equal split when every basis is 0', () => {
    const out = allocateByBasis(krw('100'), [line(0n, 1), line(0n, 2), line(0n, 3)]);
    expect(out.map((m) => m.toNumeric())).toEqual(['34.0000', '33.0000', '33.0000']);
    expect(sum(out, krw('0')).toNumeric()).toBe('100.0000');
  });

  it('breaks remainder ties by ascending line_no, NOT array order', () => {
    // Two equal-weight lines, 1 won to hand out; the line whose lineNo is smaller wins it.
    const out = allocateByBasis(krw('1'), [line(1n, 2), line(1n, 1)]);
    expect(out.map((m) => m.toNumeric())).toEqual(['0.0000', '1.0000']);
  });

  it('conserves the total exactly across an awkward many-line split', () => {
    const lines = [line(7n, 1), line(11n, 2), line(13n, 3), line(2n, 4), line(1n, 5)];
    const out = allocateByBasis(krw('1000'), lines);
    expect(sum(out, krw('0')).toNumeric()).toBe('1000.0000');
    // Every share is a whole won (KRW minor unit 0) and non-negative.
    for (const m of out) {
      expect(m.minorUnits >= 0n).toBe(true);
      expect(m.toDecimal()).toMatch(/^\d+$/);
    }
  });

  it('is deterministic (same input → identical output)', () => {
    const lines = [line(3n, 1), line(5n, 2), line(7n, 3)];
    const a = allocateByBasis(krw('100'), lines).map((m) => m.toNumeric());
    const b = allocateByBasis(krw('100'), lines).map((m) => m.toNumeric());
    expect(a).toEqual(b);
  });

  it('allocates a zero total to all-zero shares', () => {
    const out = allocateByBasis(krw('0'), [line(100n, 1), line(200n, 2)]);
    expect(out.map((m) => m.toNumeric())).toEqual(['0.0000', '0.0000']);
  });

  it('rejects a negative total and negative basis', () => {
    expect(() => allocateByBasis(krw('-1'), [line(1n, 1)])).toThrow();
    expect(() => allocateByBasis(krw('100'), [line(-1n, 1)])).toThrow();
  });
});
