import { describe, it, expect } from 'vitest';
import { moneySchema, currencyCodeSchema } from './money.js';

describe('moneySchema', () => {
  it('accepts NUMERIC(18,2)-shaped decimal strings', () => {
    expect(moneySchema.safeParse('100').success).toBe(true);
    expect(moneySchema.safeParse('100.5').success).toBe(true);
    expect(moneySchema.safeParse('100.50').success).toBe(true);
    expect(moneySchema.safeParse('-12.34').success).toBe(true);
  });

  it('rejects floats with too many fraction digits and non-numeric input', () => {
    expect(moneySchema.safeParse('100.123').success).toBe(false);
    expect(moneySchema.safeParse('1e3').success).toBe(false);
    expect(moneySchema.safeParse('abc').success).toBe(false);
  });
});

describe('currencyCodeSchema', () => {
  it('accepts 3-letter upper-case ISO codes', () => {
    expect(currencyCodeSchema.safeParse('KRW').success).toBe(true);
    expect(currencyCodeSchema.safeParse('usd').success).toBe(false);
    expect(currencyCodeSchema.safeParse('US').success).toBe(false);
  });
});
