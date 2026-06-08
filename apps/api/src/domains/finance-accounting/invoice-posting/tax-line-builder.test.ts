import { describe, expect, it } from 'vitest';
import { Money } from '@erp/kernel';
import { buildTaxLines, type TaxCodeInfo, type TaxableLine } from './tax-line-builder.js';

/**
 * Tax calc unit tests (root CLAUDE.md §5.4 — VAT math is mandatory-tested incl. edge cases). Pins the
 * two locked decisions: D1 (round per line, then aggregate per tax code) and D2 (half-away default,
 * truncation as an option). Uses the kernel's built-in ISO-4217 minor units (KRW=0, USD=2).
 */

const CODES: ReadonlyMap<string, TaxCodeInfo> = new Map<string, TaxCodeInfo>([
  ['V10', { code: 'V10', ratePercent: '10', glAccount: '2550' }],
  ['V00', { code: 'V00', ratePercent: '0', glAccount: '2550' }], // zero-rated (영세율)
  ['V105', { code: 'V105', ratePercent: '10.5', glAccount: '2550' }],
]);

const krw = (v: string): Money => Money.of(v, 'KRW');
const usd = (v: string): Money => Money.of(v, 'USD');
const line = (net: Money, taxCode?: string): TaxableLine => ({ net, taxCode });

describe('buildTaxLines', () => {
  it('computes VAT for a single line and the gross total', () => {
    const r = buildTaxLines([line(krw('100000'), 'V10')], CODES);
    expect(r.taxLines).toHaveLength(1);
    expect(r.taxLines[0]).toMatchObject({ taxCode: 'V10', glAccount: '2550' });
    expect(r.taxLines[0]!.tax.toNumeric()).toBe('10000.0000');
    expect(r.totalNet.toNumeric()).toBe('100000.0000');
    expect(r.totalTax.toNumeric()).toBe('10000.0000');
    expect(r.grandTotal.toNumeric()).toBe('110000.0000');
  });

  // D1: the locked encoding test. 3 × 1,235 @ 10% rounds per line (123.5 → 124) then sums to 372.
  it('D1 — rounds per line then aggregates: 3×1,235 @10% → 372 (NOT the 371 of a doc-total round)', () => {
    const perLine = buildTaxLines(
      [line(krw('1235'), 'V10'), line(krw('1235'), 'V10'), line(krw('1235'), 'V10')],
      CODES,
    );
    expect(perLine.taxLines).toHaveLength(1);
    expect(perLine.taxLines[0]!.base.toNumeric()).toBe('3705.0000');
    expect(perLine.taxLines[0]!.tax.toNumeric()).toBe('372.0000');
    expect(perLine.grandTotal.toNumeric()).toBe('4077.0000');

    // Contrast: one combined 3,705 line @10% rounds once → 371. Itemised invoices must use 372.
    const docTotal = buildTaxLines([line(krw('3705'), 'V10')], CODES);
    expect(docTotal.taxLines[0]!.tax.toNumeric()).toBe('371.0000');
    expect(perLine.totalTax.equals(docTotal.totalTax)).toBe(false);
  });

  it('D1 holds for a 2-decimal currency too: 3×0.05 USD @10% → 0.03 (doc-total would be 0.02)', () => {
    const perLine = buildTaxLines(
      [line(usd('0.05'), 'V10'), line(usd('0.05'), 'V10'), line(usd('0.05'), 'V10')],
      CODES,
    );
    expect(perLine.taxLines[0]!.tax.toNumeric()).toBe('0.0300');
    expect(buildTaxLines([line(usd('0.15'), 'V10')], CODES).taxLines[0]!.tax.toNumeric()).toBe(
      '0.0200',
    );
  });

  it('aggregates lines under the same code and keeps distinct codes as separate lines, first-seen order', () => {
    const r = buildTaxLines(
      [line(krw('1000'), 'V10'), line(krw('2000'), 'V00'), line(krw('3000'), 'V10')],
      CODES,
    );
    expect(r.taxLines.map((t) => t.taxCode)).toEqual(['V10', 'V00']);
    expect(r.taxLines[0]!.base.toNumeric()).toBe('4000.0000'); // 1000 + 3000
    expect(r.taxLines[0]!.tax.toNumeric()).toBe('400.0000');
    expect(r.taxLines[1]!.tax.toNumeric()).toBe('0.0000'); // zero-rated: kept, tax 0
    expect(r.totalNet.toNumeric()).toBe('6000.0000');
    expect(r.totalTax.toNumeric()).toBe('400.0000');
  });

  it('treats a line without a tax code as VAT-free but still in the net/gross totals', () => {
    const r = buildTaxLines([line(krw('5000'), 'V10'), line(krw('3000'))], CODES);
    expect(r.taxLines).toHaveLength(1);
    expect(r.totalNet.toNumeric()).toBe('8000.0000');
    expect(r.totalTax.toNumeric()).toBe('500.0000');
    expect(r.grandTotal.toNumeric()).toBe('8500.0000');
  });

  // D2: half-away (default) vs the truncation option, on the canonical 19.9¢ case.
  it('D2 — HALF_UP rounds 1.99 USD @10% to 0.20; TRUNCATE floors it to 0.19', () => {
    expect(buildTaxLines([line(usd('1.99'), 'V10')], CODES).taxLines[0]!.tax.toNumeric()).toBe(
      '0.2000',
    );
    expect(
      buildTaxLines([line(usd('1.99'), 'V10')], CODES, 'TRUNCATE').taxLines[0]!.tax.toNumeric(),
    ).toBe('0.1900');
  });

  it('D2 — TRUNCATE handles a fractional rate (10.5%): floors 1,000 KRW @10.5% to 105', () => {
    expect(buildTaxLines([line(krw('1000'), 'V105')], CODES).taxLines[0]!.tax.toNumeric()).toBe(
      '105.0000',
    );
    // 1,005 @10.5% = 105.525 → HALF_UP 106, TRUNCATE 105.
    expect(buildTaxLines([line(krw('1005'), 'V105')], CODES).taxLines[0]!.tax.toNumeric()).toBe(
      '106.0000',
    );
    expect(
      buildTaxLines([line(krw('1005'), 'V105')], CODES, 'TRUNCATE').taxLines[0]!.tax.toNumeric(),
    ).toBe('105.0000');
  });

  it('keeps grandTotal == totalNet + totalTax', () => {
    const r = buildTaxLines([line(krw('1234'), 'V10'), line(krw('5678'), 'V105')], CODES);
    expect(r.grandTotal.equals(r.totalNet.add(r.totalTax))).toBe(true);
  });

  it('rejects empty input, currency mismatch, and an unresolved tax code', () => {
    expect(() => buildTaxLines([], CODES)).toThrow(/at least one line/);
    expect(() => buildTaxLines([line(krw('100'), 'V10'), line(usd('1'), 'V10')], CODES)).toThrow(
      /currency/,
    );
    expect(() => buildTaxLines([line(krw('100'), 'NOPE')], CODES)).toThrow(/not resolved/);
  });
});
