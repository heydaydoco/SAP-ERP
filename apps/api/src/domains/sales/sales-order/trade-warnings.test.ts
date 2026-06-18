import { describe, expect, it } from 'vitest';
import { exportTaxWarnings } from './trade-warnings.js';

/**
 * EXPORT-contradiction soft warning (§5) — the 영세율 분기 classifier. trade_direction NEVER picks the
 * rate; this only flags a likely mistake (EXP carrying a taxable code) and warns, never blocks.
 */
describe('exportTaxWarnings', () => {
  it('warns on EXP + a TAXABLE (rate > 0) code', () => {
    const w = exportTaxWarnings('EXP', [{ lineNo: 1, taxCode: 'V10', ratePercent: '10' }]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('V10');
    expect(w[0]).toContain('line 1');
  });

  it('does NOT warn on EXP + zero-rate (V00) — a correct export', () => {
    expect(exportTaxWarnings('EXP', [{ lineNo: 1, taxCode: 'V00', ratePercent: '0' }])).toEqual([]);
  });

  it('does NOT warn on EXP + no tax code', () => {
    expect(exportTaxWarnings('EXP', [{ lineNo: 1, taxCode: null, ratePercent: null }])).toEqual([]);
  });

  it('does NOT warn on DOM + V00 (legitimate 내국신용장/구매확인서 영세율) — never blocked', () => {
    expect(exportTaxWarnings('DOM', [{ lineNo: 1, taxCode: 'V00', ratePercent: '0' }])).toEqual([]);
  });

  it('does NOT warn on DOM + a taxable code (ordinary domestic sale)', () => {
    expect(exportTaxWarnings('DOM', [{ lineNo: 1, taxCode: 'V10', ratePercent: '10' }])).toEqual([]);
  });

  it('does NOT warn when the direction is null or IMP (not tax-relevant here)', () => {
    const line = [{ lineNo: 1, taxCode: 'V10', ratePercent: '10' }];
    expect(exportTaxWarnings(null, line)).toEqual([]);
    expect(exportTaxWarnings(undefined, line)).toEqual([]);
    expect(exportTaxWarnings('IMP', line)).toEqual([]);
  });

  it('flags only the taxable lines on a mixed EXP order', () => {
    const w = exportTaxWarnings('EXP', [
      { lineNo: 1, taxCode: 'V00', ratePercent: '0' },
      { lineNo: 2, taxCode: 'V10', ratePercent: '10' },
      { lineNo: 3, taxCode: null, ratePercent: null },
    ]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('line 2');
  });
});
