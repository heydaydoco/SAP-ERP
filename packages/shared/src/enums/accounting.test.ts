import { describe, expect, it } from 'vitest';
import { glAccountTypeSchema, normalBalance } from './accounting';

// Normal balance drives fi-posting's debit/credit validation (root CLAUDE.md §3.2, §5.4).
describe('normalBalance', () => {
  it('makes assets and expenses debit-normal', () => {
    expect(normalBalance('ASSET')).toBe('D');
    expect(normalBalance('EXPENSE')).toBe('D');
  });

  it('makes liabilities, equity, and revenue credit-normal', () => {
    expect(normalBalance('LIABILITY')).toBe('C');
    expect(normalBalance('EQUITY')).toBe('C');
    expect(normalBalance('REVENUE')).toBe('C');
  });

  it('covers every account type in the enum', () => {
    for (const type of glAccountTypeSchema.options) {
      expect(['D', 'C']).toContain(normalBalance(type));
    }
  });
});
