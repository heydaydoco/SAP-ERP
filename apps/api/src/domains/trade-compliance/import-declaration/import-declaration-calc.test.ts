import { describe, expect, it } from 'vitest';
import {
  amountsMatch,
  dutyWithinTolerance,
  expectedDutyAmount,
  sumCustomsValues,
  type CustomsValueLine,
  type DutyLine,
} from './import-declaration-calc.js';

/**
 * Import-declaration math (§5.4) — exact per-currency minor units via the kernel `Money`. Uses the default
 * ISO_4217 registry (KRW=0, USD=2, BHD=3), so currency-precision enforcement is exercised without a DB.
 */
describe('sumCustomsValues', () => {
  const lines = (...amounts: string[]): CustomsValueLine[] =>
    amounts.map((customsValue, i) => ({ lineNo: i + 1, customsValue }));

  it('sums USD lines to a NUMERIC(18,4) string', () => {
    expect(sumCustomsValues(lines('100.00', '50.50', '0.99'), 'USD')).toBe('151.4900');
  });

  it('sums whole-won KRW lines (minor unit 0)', () => {
    expect(sumCustomsValues(lines('1000', '2500', '300'), 'KRW')).toBe('3800.0000');
  });

  it('returns 0.0000 for an empty declaration', () => {
    expect(sumCustomsValues([], 'USD')).toBe('0.0000');
  });

  it('is exact on a single line (no rounding drift)', () => {
    expect(sumCustomsValues(lines('12345.67'), 'USD')).toBe('12345.6700');
    expect(sumCustomsValues(lines('999999'), 'KRW')).toBe('999999.0000');
  });

  it('rejects a KRW amount carrying decimals (minor unit 0), naming the line', () => {
    expect(() => sumCustomsValues(lines('1000', '100.50'), 'KRW')).toThrow(/line 2/);
    expect(() => sumCustomsValues(lines('100.50'), 'KRW')).toThrow(/more decimals than KRW allows/);
  });

  it('rejects a USD amount with more than 2 decimals, naming the line', () => {
    expect(() => sumCustomsValues(lines('10.00', '5.005'), 'USD')).toThrow(/line 2/);
    expect(() => sumCustomsValues(lines('5.005'), 'USD')).toThrow(/more decimals than USD allows/);
  });

  it('rejects a malformed amount', () => {
    expect(() => sumCustomsValues(lines('abc'), 'USD')).toThrow(/line 1/);
  });

  it('honours a 3-decimal currency (BHD, minor unit 3)', () => {
    expect(sumCustomsValues(lines('1.234', '2.766'), 'BHD')).toBe('4.0000');
    expect(() => sumCustomsValues(lines('1.2345'), 'BHD')).toThrow(/more decimals than BHD allows/);
  });
});

describe('expectedDutyAmount', () => {
  const dutyLines = (...pairs: [string, string | null][]): DutyLine[] =>
    pairs.map(([customsValue, dutyRate]) => ({ customsValue, dutyRate }));

  it('sums 과세가격 × 관세율% per line (USD, exact)', () => {
    // 1000.00 × 8% = 80.00 ; 500.00 × 5% = 25.00 → 105.0000
    expect(expectedDutyAmount(dutyLines(['1000.00', '8'], ['500.00', '5']), 'USD')).toBe('105.0000');
  });

  it('rounds half away from zero at the currency minor unit (KRW)', () => {
    // 1234 × 6.5% = 80.21 → 80 won ; 5 × 10% = 0.5 → 1 won (half away)
    expect(expectedDutyAmount(dutyLines(['1234', '6.5']), 'KRW')).toBe('80.0000');
    expect(expectedDutyAmount(dutyLines(['5', '10']), 'KRW')).toBe('1.0000');
  });

  it('treats a 0% line (FTA 특혜) as no duty', () => {
    expect(expectedDutyAmount(dutyLines(['1000.00', '0'], ['500.00', '8']), 'USD')).toBe('40.0000');
  });

  it('is NOT estimable (null) when any line omits its duty rate', () => {
    expect(expectedDutyAmount(dutyLines(['1000.00', '8'], ['500.00', null]), 'USD')).toBeNull();
  });
});

describe('amountsMatch', () => {
  it('treats trailing-zero NUMERIC strings as equal for a minor-unit-0 currency', () => {
    expect(amountsMatch('1500', '1500.0000', 'KRW')).toBe(true);
  });

  it('is exact (USD cents)', () => {
    expect(amountsMatch('100.50', '100.50', 'USD')).toBe(true);
    expect(amountsMatch('1500', '1501', 'KRW')).toBe(false);
  });
});

describe('dutyWithinTolerance', () => {
  it('is within when |declared − expected| ≤ 1% of expected', () => {
    expect(dutyWithinTolerance('100.0000', '100.0000', 'USD')).toBe(true); // exact
    expect(dutyWithinTolerance('100.9900', '100.0000', 'USD')).toBe(true); // 0.99% off
    expect(dutyWithinTolerance('101.0000', '100.0000', 'USD')).toBe(true); // exactly 1% (inclusive)
  });

  it('is outside when the deviation exceeds 1%', () => {
    expect(dutyWithinTolerance('105.0000', '100.0000', 'USD')).toBe(false);
  });

  it('handles a zero expected (within iff declared is also zero)', () => {
    expect(dutyWithinTolerance('0.0000', '0.0000', 'USD')).toBe(true);
    expect(dutyWithinTolerance('5.0000', '0.0000', 'USD')).toBe(false);
  });

  it('parses canonical KRW trailing-zero strings (Money.fromNumeric, not Money.of — latent-crash guard)', () => {
    // KRW minor unit 0 → Money.of('1500.0000','KRW') would THROW; fromNumeric must accept it.
    expect(dutyWithinTolerance('1500.0000', '1500.0000', 'KRW')).toBe(true);
    expect(dutyWithinTolerance('1500.0000', '1000.0000', 'KRW')).toBe(false);
  });
});
