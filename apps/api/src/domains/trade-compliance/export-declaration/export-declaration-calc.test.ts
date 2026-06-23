import { describe, expect, it } from 'vitest';
import { sumFobAmounts, type FobLine } from './export-declaration-calc.js';

/**
 * FOB total math (§5.4) — exact per-currency minor units via the kernel `Money`. Uses the default
 * ISO_4217 registry (KRW=0, USD=2, BHD=3), so currency-precision enforcement is exercised without a DB.
 */
describe('sumFobAmounts', () => {
  const lines = (...amounts: string[]): FobLine[] =>
    amounts.map((fobAmount, i) => ({ lineNo: i + 1, fobAmount }));

  it('sums USD lines to a NUMERIC(18,4) string', () => {
    expect(sumFobAmounts(lines('100.00', '50.50', '0.99'), 'USD')).toBe('151.4900');
  });

  it('sums whole-won KRW lines (minor unit 0)', () => {
    expect(sumFobAmounts(lines('1000', '2500', '300'), 'KRW')).toBe('3800.0000');
  });

  it('returns 0.0000 for an empty declaration', () => {
    expect(sumFobAmounts([], 'USD')).toBe('0.0000');
  });

  it('is exact on a single line (no rounding drift)', () => {
    expect(sumFobAmounts(lines('12345.67'), 'USD')).toBe('12345.6700');
    expect(sumFobAmounts(lines('999999'), 'KRW')).toBe('999999.0000');
  });

  it('rejects a KRW amount carrying decimals (minor unit 0), naming the line', () => {
    expect(() => sumFobAmounts(lines('1000', '100.50'), 'KRW')).toThrow(/line 2/);
    expect(() => sumFobAmounts(lines('100.50'), 'KRW')).toThrow(/more decimals than KRW allows/);
  });

  it('rejects a USD amount with more than 2 decimals, naming the line', () => {
    expect(() => sumFobAmounts(lines('10.00', '5.005'), 'USD')).toThrow(/line 2/);
    expect(() => sumFobAmounts(lines('5.005'), 'USD')).toThrow(/more decimals than USD allows/);
  });

  it('rejects a malformed amount', () => {
    expect(() => sumFobAmounts(lines('abc'), 'USD')).toThrow(/line 1/);
  });

  it('honours a 3-decimal currency (BHD, minor unit 3)', () => {
    expect(sumFobAmounts(lines('1.234', '2.766'), 'BHD')).toBe('4.0000');
    expect(() => sumFobAmounts(lines('1.2345'), 'BHD')).toThrow(/more decimals than BHD allows/);
  });
});
