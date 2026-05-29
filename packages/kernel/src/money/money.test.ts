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
