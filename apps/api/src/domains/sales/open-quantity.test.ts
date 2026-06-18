import { describe, expect, it } from 'vitest';
import { parseScaled6 as q } from '../inventory-warehouse/inventory/map.js';
import { exceedsOpen, openQty6 } from './open-quantity.js';

/** Open-quantity math (§5.4) — the shared delivery/billing guard primitive, scale-6 bigint pure. */
describe('openQty6', () => {
  it('open = limit − prior − running', () => {
    expect(openQty6(q('10'), q('3'), q('2'))).toBe(q('5'));
    expect(openQty6(q('10'), q('0'), q('0'))).toBe(q('10'));
    expect(openQty6(q('10.5'), q('0.25'), q('0.25'))).toBe(q('10'));
  });

  it('clamps at zero — never reports a negative open quantity', () => {
    expect(openQty6(q('10'), q('10'), q('0'))).toBe(0n);
    expect(openQty6(q('10'), q('8'), q('5'))).toBe(0n);
  });
});

describe('exceedsOpen', () => {
  it('is false up to and including the exact open quantity', () => {
    // ordered 10, none prior/running → billing exactly 10 is allowed.
    expect(exceedsOpen(q('10'), q('0'), q('0'), q('10'))).toBe(false);
    // 3 prior + 2 running + 5 requested = 10 == limit → allowed.
    expect(exceedsOpen(q('10'), q('3'), q('2'), q('5'))).toBe(false);
    // a fractional sliver within the remainder.
    expect(exceedsOpen(q('10'), q('9.999999'), q('0'), q('0.000001'))).toBe(false);
  });

  it('is true one minor unit over the open quantity', () => {
    expect(exceedsOpen(q('10'), q('3'), q('2'), q('6'))).toBe(true); // 11 > 10
    expect(exceedsOpen(q('10'), q('9.999999'), q('0'), q('0.000002'))).toBe(true);
  });

  it('catches the running-map two-lines-on-one-item case (no pre-document bypass)', () => {
    // SO item ordered 10. Line A requests 6 against prior 0, running 0 → ok; sets running 6.
    expect(exceedsOpen(q('10'), q('0'), q('0'), q('6'))).toBe(false);
    // Line B requests 5 against prior 0, running 6 → 11 > 10 → rejected.
    expect(exceedsOpen(q('10'), q('0'), q('6'), q('5'))).toBe(true);
  });
});
