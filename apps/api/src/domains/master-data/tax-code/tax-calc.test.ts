import { Money } from '@erp/kernel';
import { describe, expect, it } from 'vitest';
import { computeTax } from './tax-calc';

// VAT must round to each currency's minor unit, never a hard-coded 2 decimals (§3.1, §5.4).
describe('computeTax — VAT on a base amount', () => {
  it('10% output VAT on KRW (0-decimal) rounds to whole won', () => {
    expect(computeTax(Money.of('15000', 'KRW'), '10').toDecimal()).toBe('1500');
    expect(computeTax(Money.of('15', 'KRW'), '10').toDecimal()).toBe('2'); // 1.5 → 2 (half up)
  });

  it('10% VAT on USD (2-decimal) rounds to cents', () => {
    expect(computeTax(Money.of('1.99', 'USD'), '10').toDecimal()).toBe('0.20');
    expect(computeTax(Money.of('100.00', 'USD'), '10').toDecimal()).toBe('10.00');
  });

  it('a zero-rate code yields zero tax', () => {
    expect(computeTax(Money.of('1000.00', 'USD'), '0').isZero()).toBe(true);
  });
});
