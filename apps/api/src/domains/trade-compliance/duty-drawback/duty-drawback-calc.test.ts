import { describe, expect, it } from 'vitest';
import { Money } from '@erp/kernel';
import {
  manualFobDeviationExceeds,
  parseRatePer10k,
  simplifiedLineRefund,
  sumRefunds,
} from './duty-drawback-calc.js';

/** KRW Money helper (default ISO_4217 registry → KRW minorUnit 0). */
const krw = (won: string | number) => Money.of(won, 'KRW');

describe('duty-drawback-calc (§5.4)', () => {
  describe('parseRatePer10k', () => {
    it('parses an integer rate to a ×10^4 scaled bigint', () => {
      expect(parseRatePer10k('50')).toBe(500000n);
      expect(parseRatePer10k('50.0000')).toBe(500000n);
      expect(parseRatePer10k('120.5')).toBe(1205000n);
      expect(parseRatePer10k('0')).toBe(0n);
    });
    it('rejects an over-precision or malformed rate', () => {
      expect(() => parseRatePer10k('1.23456')).toThrow();
      expect(() => parseRatePer10k('-5')).toThrow();
      expect(() => parseRatePer10k('abc')).toThrow();
    });
  });

  describe('simplifiedLineRefund — round(fob_krw / 10,000 × rate_per_10k)', () => {
    it('computes a whole-won refund (1,000,000원 × 50원/만원 = 5,000원)', () => {
      expect(simplifiedLineRefund(krw('1000000'), '50.0000').toNumeric()).toBe('5000.0000');
    });

    it('refund is 0 when the rate is 0 (개별환급 대상/률표 누락)', () => {
      expect(simplifiedLineRefund(krw('1000000'), '0').toNumeric()).toBe('0.0000');
    });

    it('HALF_UP (반올림, default) rounds a .5 residue away from zero', () => {
      // 15,000원 × 1원/만원 = 1.5원 → 2원
      expect(simplifiedLineRefund(krw('15000'), '1.0000', 'HALF_UP').toNumeric()).toBe('2.0000');
    });

    it('FLOOR (원미만 절사) truncates the same .5 residue down', () => {
      // 15,000원 × 1원/만원 = 1.5원 → 1원
      expect(simplifiedLineRefund(krw('15000'), '1.0000', 'FLOOR').toNumeric()).toBe('1.0000');
    });

    it('HALF_UP vs FLOOR agree on an exact (no-residue) result', () => {
      expect(simplifiedLineRefund(krw('20000'), '1.0000', 'HALF_UP').toNumeric()).toBe('2.0000');
      expect(simplifiedLineRefund(krw('20000'), '1.0000', 'FLOOR').toNumeric()).toBe('2.0000');
    });

    it('handles a fractional rate exactly via integer math (no float drift)', () => {
      // 1,000,000원 × 33.3355원/만원 / 10,000 = 3,333.55원 → HALF_UP 3334 / FLOOR 3333
      // 1000000 × 333355 / 10^8 = 333,355,000,000 / 10^8 = 3333.55
      expect(simplifiedLineRefund(krw('1000000'), '33.3355', 'HALF_UP').toNumeric()).toBe('3334.0000');
      expect(simplifiedLineRefund(krw('1000000'), '33.3355', 'FLOOR').toNumeric()).toBe('3333.0000');
    });

    it('rejects a non-KRW base (the refund basis must already be KRW)', () => {
      expect(() => simplifiedLineRefund(Money.of('100', 'USD'), '50')).toThrow(/KRW/);
    });
  });

  describe('sumRefunds', () => {
    it('sums line refunds (KRW); empty is 0', () => {
      expect(sumRefunds([]).toNumeric()).toBe('0.0000');
      expect(sumRefunds([krw('5000'), krw('1524'), krw('0')]).toNumeric()).toBe('6524.0000');
    });
  });

  describe('manualFobDeviationExceeds — tolerance max(1,000원, 1%)', () => {
    it('within tolerance when diff ≤ both 1,000원 and 1%', () => {
      // auto 1,000,000 (1% = 10,000); manual 1,005,000 → diff 5,000 ≤ 10,000 → within
      expect(manualFobDeviationExceeds(krw('1005000'), krw('1000000'))).toBe(false);
    });
    it('exceeds when diff > the larger bound (1% on a large amount)', () => {
      // auto 1,000,000 (1% = 10,000); manual 1,011,000 → diff 11,000 > 10,000 AND > 1,000 → exceeds
      expect(manualFobDeviationExceeds(krw('1011000'), krw('1000000'))).toBe(true);
    });
    it('the 1,000원 floor dominates on a small amount', () => {
      // auto 10,000 (1% = 100); manual 11,500 → diff 1,500 > 1,000 → exceeds
      expect(manualFobDeviationExceeds(krw('11500'), krw('10000'))).toBe(true);
      // diff 900 ≤ 1,000 → within (even though 900 > 1% of 10,000)
      expect(manualFobDeviationExceeds(krw('10900'), krw('10000'))).toBe(false);
    });
    it('equal values never deviate', () => {
      expect(manualFobDeviationExceeds(krw('1000000'), krw('1000000'))).toBe(false);
    });
  });
});
