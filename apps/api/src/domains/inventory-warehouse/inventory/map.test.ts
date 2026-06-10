import { describe, expect, it } from 'vitest';
import { Money } from '@erp/kernel';
import {
  averagePrice6,
  formatScaled6,
  parseScaled6,
  receiptValue,
  valueAtAverage,
} from './map.js';

/**
 * MAP valuation math unit tests (root CLAUDE.md §5.4 — calculation logic is mandatory-tested).
 * KRW (0-decimal) and USD (2-decimal) cover the per-currency minor-unit rule: rounding always
 * lands on the CURRENCY's minor unit, never a hard-coded 2 decimals.
 */

const krw = (v: string) => Money.of(v, 'KRW');
const usd = (v: string) => Money.of(v, 'USD');

describe('parseScaled6 / formatScaled6', () => {
  it('round-trips canonical NUMERIC(18,6) strings', () => {
    expect(parseScaled6('10')).toBe(10_000000n);
    expect(parseScaled6('10.5')).toBe(10_500000n);
    expect(parseScaled6('0.000001')).toBe(1n);
    expect(formatScaled6(10_000000n)).toBe('10.000000');
    expect(formatScaled6(1n)).toBe('0.000001');
    expect(formatScaled6(parseScaled6('123.456789'))).toBe('123.456789');
  });

  it('rejects negatives, malformed input, and more than 6 decimals', () => {
    expect(() => parseScaled6('-1')).toThrow(/invalid/);
    expect(() => parseScaled6('1.2345678')).toThrow(/invalid/);
    expect(() => parseScaled6('abc')).toThrow(/invalid/);
    expect(() => parseScaled6('')).toThrow(/invalid/);
    expect(() => formatScaled6(-1n)).toThrow(/non-negative/);
  });
});

describe('receiptValue (561/101 priced receipts)', () => {
  it('values qty × unitPrice exactly in the currency minor unit', () => {
    expect(receiptValue(parseScaled6('10'), parseScaled6('1000'), krw('0')).toDecimal()).toBe(
      '10000',
    );
    expect(receiptValue(parseScaled6('2.5'), parseScaled6('1200'), krw('0')).toDecimal()).toBe(
      '3000',
    );
  });

  it('rounds half away from zero to the CURRENCY minor unit (KRW 0dp vs USD 2dp)', () => {
    // 3 × 33.333333 = 99.999999 → KRW 100
    expect(receiptValue(parseScaled6('3'), parseScaled6('33.333333'), krw('0')).toDecimal()).toBe(
      '100',
    );
    // 0.5 × 0.01 = 0.005 → exactly half a cent → away from zero → $0.01
    expect(receiptValue(parseScaled6('0.5'), parseScaled6('0.01'), usd('0')).toDecimal()).toBe(
      '0.01',
    );
    // 1.5 KRW (sub-won receipt value) → rounds to 2 (half away), not banker's 2? 1.5 → 2
    expect(receiptValue(parseScaled6('3'), parseScaled6('0.5'), krw('0')).toDecimal()).toBe('2');
  });

  it('rejects non-positive quantity', () => {
    expect(() => receiptValue(0n, 1n, krw('0'))).toThrow(/positive/);
  });
});

describe('valueAtAverage (201/711 issues · 712 surplus)', () => {
  it('takes the exact proportional share of stock_value (no double rounding via stored price)', () => {
    // stock: 20 @ avg 1500 = 30000 KRW; issue 5 → 7500
    expect(
      valueAtAverage(parseScaled6('5'), parseScaled6('20'), krw('30000')).toDecimal(),
    ).toBe('7500');
    // ragged: value 100 KRW over qty 3 → issue 1 = round(100/3) = 33
    expect(valueAtAverage(parseScaled6('1'), parseScaled6('3'), krw('100')).toDecimal()).toBe('33');
  });

  it('a FULL issue returns the entire remaining value — zero qty ⇒ zero value, no residue', () => {
    expect(
      valueAtAverage(parseScaled6('17'), parseScaled6('17'), krw('25500')).toDecimal(),
    ).toBe('25500');
    // the ragged tail: after issuing 1 of 3 (33), issuing the remaining 2 takes all 67
    expect(valueAtAverage(parseScaled6('2'), parseScaled6('2'), krw('67')).toDecimal()).toBe('67');
  });

  it('issue series conserves value exactly: Σ issue values == initial stock value', () => {
    let value = krw('100');
    let qty = parseScaled6('3');
    let issued = krw('0');
    for (const q of ['1', '1', '1']) {
      const part = valueAtAverage(parseScaled6(q), qty, value);
      issued = issued.add(part);
      value = value.subtract(part);
      qty -= parseScaled6(q);
    }
    expect(issued.toDecimal()).toBe('100');
    expect(value.isZero()).toBe(true);
  });

  it('guards: zero stock, over-quantity, non-positive qty', () => {
    expect(() => valueAtAverage(1n, 0n, krw('0'))).toThrow(/no stock quantity/);
    expect(() => valueAtAverage(parseScaled6('4'), parseScaled6('3'), krw('100'))).toThrow(
      /exceeds/,
    );
    expect(() => valueAtAverage(0n, parseScaled6('3'), krw('100'))).toThrow(/positive/);
  });

  it('allowExceed (712 surplus): values qty > stockQty at the current average, MAP-neutral', () => {
    // book 2 @ 1000 = 2000; surplus 5 (> book) → 5 × 1000 = 5000, average unchanged.
    const surplus = valueAtAverage(parseScaled6('5'), parseScaled6('2'), krw('2000'), true);
    expect(surplus.toDecimal()).toBe('5000');
    // the proportional formula still holds for a ragged value: 100 over 2, surplus 5 → 250.
    expect(valueAtAverage(parseScaled6('5'), parseScaled6('2'), krw('100'), true).toDecimal()).toBe(
      '250',
    );
    // and the over-quantity guard still fires when allowExceed is false (the issue path).
    expect(() => valueAtAverage(parseScaled6('5'), parseScaled6('2'), krw('2000'))).toThrow(
      /exceeds/,
    );
  });
});

describe('averagePrice6 (derived MAP, scale 6)', () => {
  it('derives value / qty at scale 6, half away from zero', () => {
    expect(averagePrice6(parseScaled6('10'), krw('10000'))).toBe(parseScaled6('1000'));
    expect(averagePrice6(parseScaled6('20'), krw('30000'))).toBe(parseScaled6('1500'));
    // 100 KRW / 3 → 33.333333 (truncated repeating third)
    expect(averagePrice6(parseScaled6('3'), krw('100'))).toBe(parseScaled6('33.333333'));
    // $1.00 / 3 → 0.333333
    expect(averagePrice6(parseScaled6('3'), usd('1.00'))).toBe(parseScaled6('0.333333'));
  });

  it('is 0 for zero quantity (issues never call this — MAP survives an emptied stock)', () => {
    expect(averagePrice6(0n, krw('0'))).toBe(0n);
  });

  it('receipt + recompute walkthrough: the 561→101 moving average story', () => {
    // 561: 10 @ 1000 → value 10000, MAP 1000
    const zero = krw('0');
    const first = receiptValue(parseScaled6('10'), parseScaled6('1000'), zero);
    let qty = parseScaled6('10');
    let value = zero.add(first);
    expect(averagePrice6(qty, value)).toBe(parseScaled6('1000'));
    // 101: +10 @ 2000 → value 30000 over 20 → MAP 1500 (new_avg = new_value / new_qty)
    const second = receiptValue(parseScaled6('10'), parseScaled6('2000'), zero);
    qty += parseScaled6('10');
    value = value.add(second);
    expect(value.toDecimal()).toBe('30000');
    expect(averagePrice6(qty, value)).toBe(parseScaled6('1500'));
  });
});
