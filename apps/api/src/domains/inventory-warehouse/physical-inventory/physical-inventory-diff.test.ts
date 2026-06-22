import { describe, expect, it } from 'vitest';
import { parseScaled6 } from '../inventory/map.js';
import {
  classifyDiff,
  formatSignedScaled6,
  parseSignedScaled6,
} from './physical-inventory-diff.js';

/**
 * Physical-inventory difference math (§5.4). The VALUE of an adjustment is the engine's job
 * (valueAtAverage); this only decides direction + magnitude from the counted difference, and the
 * signed scale-6 codec for the persisted `diff_qty` (which is negative for a loss).
 */

const q = (v: string) => parseScaled6(v);

describe('classifyDiff (physical − book → 701 gain / 702 loss / none)', () => {
  it('physical > book ⇒ 701 gain with the positive magnitude', () => {
    expect(classifyDiff(q('8'), q('10'))).toEqual({ movementType: '701', magnitude6: q('2') });
  });

  it('physical < book ⇒ 702 loss with the positive magnitude', () => {
    expect(classifyDiff(q('10'), q('7'))).toEqual({ movementType: '702', magnitude6: q('3') });
  });

  it('physical == book ⇒ null (no movement, no journal)', () => {
    expect(classifyDiff(q('10'), q('10'))).toBeNull();
  });

  it('a full loss (physical 0) ⇒ 702 of the whole book quantity', () => {
    expect(classifyDiff(q('5'), q('0'))).toEqual({ movementType: '702', magnitude6: q('5') });
  });

  it('a gain from empty book (book 0) ⇒ 701 of the whole physical quantity', () => {
    expect(classifyDiff(q('0'), q('4'))).toEqual({ movementType: '701', magnitude6: q('4') });
  });

  it('keeps fractional precision at scale 6', () => {
    expect(classifyDiff(q('1.250000'), q('1.750000'))).toEqual({
      movementType: '701',
      magnitude6: q('0.5'),
    });
  });

  it('rejects negative book or physical', () => {
    expect(() => classifyDiff(-1n, q('1'))).toThrow(/book/);
    expect(() => classifyDiff(q('1'), -1n)).toThrow(/physical/);
  });
});

describe('formatSignedScaled6 / parseSignedScaled6 (diff_qty codec)', () => {
  it('formats a positive diff like the unsigned codec', () => {
    expect(formatSignedScaled6(q('2'))).toBe('2.000000');
  });

  it('formats a negative diff with a leading minus', () => {
    expect(formatSignedScaled6(-q('3'))).toBe('-3.000000');
    expect(formatSignedScaled6(0n)).toBe('0.000000');
  });

  it('round-trips signed values', () => {
    for (const v of [q('2'), -q('3'), 0n, -q('0.5')]) {
      expect(parseSignedScaled6(formatSignedScaled6(v))).toBe(v);
    }
  });
});
