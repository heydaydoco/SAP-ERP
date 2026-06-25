import { describe, expect, it } from 'vitest';
import { stubMrn } from './unipass-stub.js';

/**
 * Stub MRN generator (§5.4 — the slice's only pure logic). The connector itself is a deferred interface
 * boundary, so the unit surface is small: the placeholder MRN must be deterministic (reproducible/idempotent),
 * type-prefixed, and fit the 35-char `declaration_no` / `mrn` columns.
 */
describe('stubMrn', () => {
  const id = '11112222-3333-4444-5555-666677778888';

  it('is deterministic — the same declaration always yields the same MRN', () => {
    expect(stubMrn('EXPORT', id)).toBe(stubMrn('EXPORT', id));
    expect(stubMrn('IMPORT', id)).toBe(stubMrn('IMPORT', id));
  });

  it('prefixes by declaration type (ED / IM)', () => {
    expect(stubMrn('EXPORT', id)).toMatch(/^STUB-ED-/);
    expect(stubMrn('IMPORT', id)).toMatch(/^STUB-IM-/);
    // The same id under different types produces different MRNs.
    expect(stubMrn('EXPORT', id)).not.toBe(stubMrn('IMPORT', id));
  });

  it('derives distinct MRNs from distinct ids, uppercased and hex-only after the prefix', () => {
    const other = '99990000-1111-2222-3333-444455556666';
    expect(stubMrn('EXPORT', id)).not.toBe(stubMrn('EXPORT', other));
    expect(stubMrn('EXPORT', id)).toBe('STUB-ED-1111222233334444');
  });

  it('fits the 35-char declaration_no / mrn column', () => {
    expect(stubMrn('EXPORT', id).length).toBeLessThanOrEqual(35);
    expect(stubMrn('IMPORT', id).length).toBeLessThanOrEqual(35);
  });
});
