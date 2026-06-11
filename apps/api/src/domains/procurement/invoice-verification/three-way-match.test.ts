import { describe, expect, it } from 'vitest';
import { parseScaled6 } from '../../inventory-warehouse/inventory/map.js';
import {
  DEFAULT_MATCH_TOLERANCE,
  matchThreeWay,
  type MatchTolerance,
} from './three-way-match.js';

/** Scale-6 literal helper. */
const s6 = (v: string): bigint => parseScaled6(v);

describe('matchThreeWay (3-way match tolerance math, §5.4)', () => {
  const base = {
    poUnitPrice6: s6('1000'),
    receivedQty6: s6('10'),
    invoicedQty6: s6('0'),
    thisInvoicedQty6: s6('10'),
    thisInvoiceUnitPrice6: s6('1000'),
  };

  it('passes an exact PO/GR/IV match and reports open-to-invoice', () => {
    const r = matchThreeWay(base);
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.openToInvoiceQty6).toBe(s6('10'));
  });

  it('blocks invoicing more than received-not-invoiced', () => {
    const r = matchThreeWay({ ...base, thisInvoicedQty6: s6('11') });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/exceeds received-not-invoiced/);
  });

  it('subtracts already-invoiced quantity from the open-to-invoice window', () => {
    // 10 received, 7 already invoiced → only 3 open; invoicing 4 is blocked, 3 is fine.
    const over = matchThreeWay({ ...base, invoicedQty6: s6('7'), thisInvoicedQty6: s6('4') });
    expect(over.ok).toBe(false);
    expect(over.openToInvoiceQty6).toBe(s6('3'));
    const ok = matchThreeWay({ ...base, invoicedQty6: s6('7'), thisInvoicedQty6: s6('3') });
    expect(ok.ok).toBe(true);
  });

  it('allows a partial invoice (less than received)', () => {
    const r = matchThreeWay({ ...base, thisInvoicedQty6: s6('6') });
    expect(r.ok).toBe(true);
  });

  it('rejects a non-positive invoiced quantity', () => {
    const r = matchThreeWay({ ...base, thisInvoicedQty6: 0n });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/must be positive/);
  });

  it('accepts a price within ±1% (default relative tolerance)', () => {
    // 1% of 1000 = 10; 1009 is within, 1010 is the boundary (inclusive), 1011 is beyond.
    expect(matchThreeWay({ ...base, thisInvoiceUnitPrice6: s6('1009') }).ok).toBe(true);
    expect(matchThreeWay({ ...base, thisInvoiceUnitPrice6: s6('1010') }).ok).toBe(true);
    const beyond = matchThreeWay({ ...base, thisInvoiceUnitPrice6: s6('1011') });
    expect(beyond.ok).toBe(false);
    expect(beyond.reasons.join(' ')).toMatch(/beyond tolerance/);
  });

  it('accepts a cheaper invoice within tolerance (negative variance)', () => {
    expect(matchThreeWay({ ...base, thisInvoiceUnitPrice6: s6('991') }).ok).toBe(true);
    expect(matchThreeWay({ ...base, thisInvoiceUnitPrice6: s6('989') }).ok).toBe(false);
  });

  it('uses the larger of the absolute and relative price tolerances', () => {
    // Absolute 50 dominates the 1% (=10) relative window: 1040 now passes.
    const tol: MatchTolerance = { ...DEFAULT_MATCH_TOLERANCE, priceAbs6: s6('50') };
    expect(matchThreeWay({ ...base, thisInvoiceUnitPrice6: s6('1040'), tolerance: tol }).ok).toBe(
      true,
    );
    expect(matchThreeWay({ ...base, thisInvoiceUnitPrice6: s6('1051'), tolerance: tol }).ok).toBe(
      false,
    );
  });

  it('honors an absolute quantity tolerance', () => {
    const tol: MatchTolerance = { ...DEFAULT_MATCH_TOLERANCE, qtyAbs6: s6('0.5') };
    expect(matchThreeWay({ ...base, thisInvoicedQty6: s6('10.5'), tolerance: tol }).ok).toBe(true);
    expect(matchThreeWay({ ...base, thisInvoicedQty6: s6('10.6'), tolerance: tol }).ok).toBe(false);
  });

  it('reports both a quantity and a price violation at once', () => {
    const r = matchThreeWay({
      ...base,
      thisInvoicedQty6: s6('12'),
      thisInvoiceUnitPrice6: s6('1100'),
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toHaveLength(2);
  });

  it('on a zero-price (free) PO line accepts only an exact-zero invoice price', () => {
    // PO price 0 ⇒ both the relative (0) and absolute (0) tolerances collapse to 0: a free line
    // must be invoiced at 0, any positive price is a variance and is blocked.
    const free = { ...base, poUnitPrice6: 0n };
    expect(matchThreeWay({ ...free, thisInvoiceUnitPrice6: 0n }).ok).toBe(true);
    const priced = matchThreeWay({ ...free, thisInvoiceUnitPrice6: s6('1') });
    expect(priced.ok).toBe(false);
    expect(priced.reasons.join(' ')).toMatch(/beyond tolerance/);
  });

  it('handles a negative open-to-invoice window without throwing (already over-invoiced)', () => {
    // Defensive: the pure function must not crash if Σinvoiced already exceeds Σreceived (the IV
    // service guards against it, but the math stays total) — it reports a blocked, negative window
    // and the reason clamps the displayed open qty to 0 (formatScaled6 rejects negatives).
    const r = matchThreeWay({ ...base, invoicedQty6: s6('12'), thisInvoicedQty6: s6('1') });
    expect(r.ok).toBe(false);
    expect(r.openToInvoiceQty6).toBe(s6('10') - s6('12'));
    expect(r.reasons.join(' ')).toMatch(/exceeds received-not-invoiced 0\.000000/);
  });
});
