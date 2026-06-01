import { describe, it, expect } from 'vitest';
import { moneySchema, currencyCodeSchema } from './money';

describe('moneySchema', () => {
  it('accepts NUMERIC(18,4)-shaped decimal strings', () => {
    expect(moneySchema.safeParse('1500').success).toBe(true); // KRW, 0 decimals
    expect(moneySchema.safeParse('1.50').success).toBe(true); // USD
    expect(moneySchema.safeParse('1.5000').success).toBe(true); // DB scale
    expect(moneySchema.safeParse('1.234').success).toBe(true); // BHD, 3 decimals
    expect(moneySchema.safeParse('-12.3456').success).toBe(true);
  });

  it('rejects more than 4 fraction digits and non-numeric input', () => {
    expect(moneySchema.safeParse('1.23456').success).toBe(false);
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
