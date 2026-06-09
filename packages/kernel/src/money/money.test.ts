import { describe, it, expect } from 'vitest';
import { Money } from './money';
import { StaticCurrencyRegistry } from './currency';

// Money is currency-aware (root CLAUDE.md §3.1): per-currency minor units, no hard-coded "cents".
describe('Money — currency-aware minor units', () => {
  it('uses 0 decimals for KRW', () => {
    const m = Money.of('1500', 'KRW');
    expect(m.minorUnits).toBe(1500n);
    expect(m.minorUnit).toBe(0);
    expect(m.toDecimal()).toBe('1500');
    expect(m.toNumeric()).toBe('1500.0000');
  });

  it('uses 2 decimals for USD', () => {
    const m = Money.of('1.50', 'USD');
    expect(m.minorUnits).toBe(150n);
    expect(m.toDecimal()).toBe('1.50');
    expect(m.toNumeric()).toBe('1.5000');
  });

  it('uses 0 decimals for JPY and 3 for BHD', () => {
    expect(Money.of('100', 'JPY').minorUnits).toBe(100n);
    expect(Money.of('1.234', 'BHD').minorUnits).toBe(1234n);
    expect(Money.of('1.234', 'BHD').toNumeric()).toBe('1.2340');
  });

  it('rejects more decimals than the currency allows', () => {
    expect(() => Money.of('1.5', 'KRW')).toThrow(/decimals/); // KRW has 0
    expect(() => Money.of('1.234', 'USD')).toThrow(/decimals/); // USD has 2
  });

  it('rejects unknown currencies instead of assuming 2 decimals', () => {
    expect(() => Money.of('1.00', 'XXX')).toThrow(/unknown currency/);
  });

  it('round-trips through NUMERIC(18,4)', () => {
    for (const [amt, cur] of [
      ['1500', 'KRW'],
      ['1.50', 'USD'],
      ['1.234', 'BHD'],
    ] as const) {
      const m = Money.of(amt, cur);
      expect(Money.fromNumeric(m.toNumeric(), cur).equals(m)).toBe(true);
    }
  });

  it('fromNumeric rejects precision finer than the currency', () => {
    expect(() => Money.fromNumeric('1.2345', 'USD')).toThrow(/finer precision/);
    expect(() => Money.fromNumeric('0.5000', 'KRW')).toThrow(/finer precision/);
  });

  it('does arithmetic exactly and guards currency mismatch', () => {
    const a = Money.of('0.10', 'USD');
    const b = Money.of('0.20', 'USD');
    expect(a.add(b).toDecimal()).toBe('0.30'); // exact, unlike 0.1 + 0.2 in float
    expect(a.subtract(b).toDecimal()).toBe('-0.10');
    expect(() => a.add(Money.of('100', 'KRW'))).toThrow(/currency mismatch/);
  });

  it('honors a custom registry (Phase 1 currency master)', () => {
    const reg = new StaticCurrencyRegistry({ KRW: 0 });
    reg.register('XYZ', 4);
    expect(Money.of('1.2345', 'XYZ', reg).minorUnits).toBe(12345n);
    expect(() => Money.of('1.00', 'USD', reg)).toThrow(/unknown currency/);
  });
});

// percentage() is the single rounding path for tax + pricing (root CLAUDE.md §4.6, §5.4).
describe('Money.percentage — rate rounding', () => {
  it('rounds half away from zero to the currency minor unit (USD, 2 decimals)', () => {
    expect(Money.of('1.99', 'USD').percentage('10').toDecimal()).toBe('0.20'); // 19.9¢ → 20¢
    expect(Money.of('1.00', 'USD').percentage('10').toDecimal()).toBe('0.10');
    expect(Money.of('0.05', 'USD').percentage('10').toDecimal()).toBe('0.01'); // 0.5¢ → 1¢ (half up)
    expect(Money.of('0.04', 'USD').percentage('10').toDecimal()).toBe('0.00'); // 0.4¢ → 0¢
  });

  it('rounds to whole units for a 0-decimal currency (KRW)', () => {
    expect(Money.of('15000', 'KRW').percentage('10').toDecimal()).toBe('1500');
    expect(Money.of('15', 'KRW').percentage('10').toDecimal()).toBe('2'); // 1.5 → 2 (half up)
    expect(Money.of('14', 'KRW').percentage('10').toDecimal()).toBe('1'); // 1.4 → 1
  });

  it('handles fractional and zero rates, and negatives symmetrically', () => {
    expect(Money.of('100.00', 'USD').percentage('10.5').toDecimal()).toBe('10.50');
    expect(Money.of('1.99', 'USD').percentage('0').toDecimal()).toBe('0.00');
    expect(Money.of('-0.05', 'USD').percentage('10').toDecimal()).toBe('-0.01'); // away from zero
  });

  it('rejects malformed percentages', () => {
    expect(() => Money.of('1.00', 'USD').percentage('abc')).toThrow(/invalid percentage/);
  });
});

// convert() is the FX translation path (root CLAUDE.md §5.4): per-line document→functional amount.
describe('Money.convert — FX translation', () => {
  it('translates to a 0-decimal functional currency (USD/EUR → KRW)', () => {
    expect(Money.of('100.00', 'USD').convert('1350', 'KRW').toDecimal()).toBe('135000');
    expect(Money.of('100.00', 'EUR').convert('1450', 'KRW').toDecimal()).toBe('145000');
  });

  it('rounds half away from zero to the target minor unit', () => {
    // 33.33 × 1350 = 44,995.5 → 44,996 (half up); 33.34 × 1350 = 45,009.0 → 45,009 (exact).
    expect(Money.of('33.33', 'USD').convert('1350', 'KRW').toDecimal()).toBe('44996');
    expect(Money.of('33.34', 'USD').convert('1350', 'KRW').toDecimal()).toBe('45009');
    // Symmetric for a negative magnitude (away from zero, not toward it).
    expect(Money.of('-33.33', 'USD').convert('1350', 'KRW').toDecimal()).toBe('-44996');
  });

  it('honours a scale-6 rate', () => {
    // 1.00 USD × 1234.567890 = 1234.56789 → 1235 KRW.
    expect(Money.of('1.00', 'USD').convert('1234.567890', 'KRW').toDecimal()).toBe('1235');
  });

  it('translates into a multi-decimal target currency (USD → BHD, 3 decimals)', () => {
    // 10.00 USD × 0.376 = 3.760 BHD.
    expect(Money.of('10.00', 'USD').convert('0.376', 'BHD').toDecimal()).toBe('3.760');
  });

  it('rejects a rate finer than the master scale, non-positive, or malformed', () => {
    expect(() => Money.of('1.00', 'USD').convert('1.1234567', 'KRW')).toThrow(/at most 6 decimals/);
    expect(() => Money.of('1.00', 'USD').convert('0', 'KRW')).toThrow(/must be positive/);
    expect(() => Money.of('1.00', 'USD').convert('-1', 'KRW')).toThrow(/invalid fx rate/);
    expect(() => Money.of('1.00', 'USD').convert('abc', 'KRW')).toThrow(/invalid fx rate/);
  });
});
