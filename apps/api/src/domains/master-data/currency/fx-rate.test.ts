import { describe, expect, it } from 'vitest';
import { resolveFxRate } from './fx-rate';

describe('resolveFxRate', () => {
  const rates = [
    { validFrom: '2026-01-01', rate: '1300.000000' },
    { validFrom: '2026-03-01', rate: '1350.000000' },
    { validFrom: '2026-02-01', rate: '1320.000000' },
  ];

  it('picks the latest rate effective on/before the date', () => {
    expect(resolveFxRate(rates, '2026-02-15')?.rate).toBe('1320.000000');
    expect(resolveFxRate(rates, '2026-03-01')?.rate).toBe('1350.000000'); // boundary is inclusive
    expect(resolveFxRate(rates, '2026-12-31')?.rate).toBe('1350.000000');
  });

  it('returns null when no rate is effective yet', () => {
    expect(resolveFxRate(rates, '2025-12-31')).toBeNull();
    expect(resolveFxRate([], '2026-01-01')).toBeNull();
  });
});
