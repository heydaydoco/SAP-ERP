import { describe, expect, it } from 'vitest';
import { deriveDueDate } from './due-date.js';

/**
 * Due-date derivation unit tests (root CLAUDE.md §5.4 — derived dates feed AR/AP aging, so the math
 * is pinned). UTC date math must roll month / year / leap-day boundaries correctly.
 */
describe('deriveDueDate', () => {
  it('returns the document date itself when terms are null or zero', () => {
    expect(deriveDueDate('2026-03-10', null)).toBe('2026-03-10');
    expect(deriveDueDate('2026-03-10', 0)).toBe('2026-03-10');
  });

  it('adds the term days within a month', () => {
    expect(deriveDueDate('2026-03-10', 15)).toBe('2026-03-25');
  });

  it('rolls a month boundary (Feb has 28 days in 2026)', () => {
    expect(deriveDueDate('2026-02-15', 30)).toBe('2026-03-17');
    expect(deriveDueDate('2026-02-10', 45)).toBe('2026-03-27');
  });

  it('rolls a year boundary', () => {
    expect(deriveDueDate('2026-12-20', 30)).toBe('2027-01-19');
  });

  it('respects the leap day: +10 from 2024-02-20 lands on Mar 1, but on Mar 2 in non-leap 2026', () => {
    expect(deriveDueDate('2024-02-20', 10)).toBe('2024-03-01');
    expect(deriveDueDate('2026-02-20', 10)).toBe('2026-03-02');
  });
});
