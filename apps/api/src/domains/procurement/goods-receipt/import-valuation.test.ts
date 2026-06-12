import { describe, expect, it } from 'vitest';
import { formatScaled6, parseScaled6 } from '../../inventory-warehouse/inventory/map.js';
import { functionalUnitPrice6, parseRate6 } from './import-valuation.js';

/**
 * Import-GR foreign→functional unit-price translation (root CLAUDE.md §5.4 — wrong math = wrong
 * money). Pure scale-6 fixed-point, half away from zero, currency-minor-unit-independent.
 */
describe('functionalUnitPrice6', () => {
  const translate = (price: string, rate: string): string =>
    formatScaled6(functionalUnitPrice6(parseScaled6(price), rate));

  it('translates a whole foreign price at a whole rate', () => {
    // 100 USD/unit × 1300 KRW/USD = 130,000 KRW/unit.
    expect(translate('100', '1300.000000')).toBe('130000.000000');
    // 1 USD × 1350 = 1350.
    expect(translate('1', '1350')).toBe('1350.000000');
  });

  it('keeps scale-6 precision for fractional prices and rates', () => {
    // 2.5 × 1300 = 3250.
    expect(translate('2.5', '1300')).toBe('3250.000000');
    // 0.376 EUR-style rate applied to a price keeps 6 decimals.
    expect(translate('10', '0.376')).toBe('3.760000');
  });

  it('rounds half away from zero at the 6th decimal', () => {
    // foreign 0.000001 × 1.5 = 0.0000015 → rounds to 0.000002.
    expect(formatScaled6(functionalUnitPrice6(1n, '1.5'))).toBe('0.000002');
    // foreign 0.000001 × 2.5 = 0.0000025 → rounds to 0.000003.
    expect(formatScaled6(functionalUnitPrice6(1n, '2.5'))).toBe('0.000003');
  });

  it('rejects a negative price and a non-positive / malformed rate', () => {
    expect(() => functionalUnitPrice6(-1n, '1300')).toThrow(/non-negative/);
    expect(() => functionalUnitPrice6(1n, '0')).toThrow(/positive/);
    expect(() => functionalUnitPrice6(1n, '-1')).toThrow(/invalid fx rate/);
    expect(() => functionalUnitPrice6(1n, '1.1234567')).toThrow(/invalid fx rate/);
  });
});

describe('parseRate6', () => {
  it('parses a scale-6 rate string into a positive scale-6 bigint', () => {
    expect(parseRate6('1350.000000')).toBe(1350_000000n);
    expect(parseRate6('1300')).toBe(1300_000000n);
    expect(parseRate6('0.5')).toBe(500000n);
  });

  it('rejects zero, negative, and over-precise rates', () => {
    expect(() => parseRate6('0')).toThrow(/positive/);
    expect(() => parseRate6('-1')).toThrow(/invalid fx rate/);
    expect(() => parseRate6('1.1234567')).toThrow(/invalid fx rate/);
  });
});
