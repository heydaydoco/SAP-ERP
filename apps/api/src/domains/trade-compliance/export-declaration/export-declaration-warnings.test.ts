import { describe, expect, it } from 'vitest';
import {
  exportDeclarationWarnings,
  type BillingTaxState,
  type ExportDeclarationWarningInput,
} from './export-declaration-warnings.js';

/**
 * Export-declaration consistency gate (§5.4) — pure, all SOFT. Covers the six required scenarios:
 * ① HS 누락 → WARN  ② billing 전부 영세율 → 무경고  ③ billing tax_code NULL → WARN (B1)
 * ④ billing 비영세율 rate>0 → WARN  ⑤ billing 미생성 → INFO  ⑥ 멱등 재생성 → 동일 warnings.
 */
describe('exportDeclarationWarnings', () => {
  const base = (over: Partial<ExportDeclarationWarningInput> = {}): ExportDeclarationWarningInput => ({
    tradeDirection: 'EXP',
    items: [{ lineNo: 1, hasHsCode: true }],
    billing: { kind: 'EXISTS', lines: [{ taxCode: 'V00', ratePercent: '0' }] },
    ...over,
  });

  // ① HS 누락 → WARN (per line)
  it('warns per item line missing an HS code', () => {
    const w = exportDeclarationWarnings(
      base({ items: [{ lineNo: 1, hasHsCode: true }, { lineNo: 2, hasHsCode: false }] }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'WARN', code: 'HS_CODE_MISSING', lineNo: 2 });
    expect(w[0]!.message).toContain('HS코드');
  });

  // ② billing 전부 영세율 (V00, rate 0) → 무경고
  it('emits NO warning when every downstream billing line is 영세율 (rate 0)', () => {
    const w = exportDeclarationWarnings(
      base({
        billing: {
          kind: 'EXISTS',
          lines: [
            { taxCode: 'V00', ratePercent: '0' },
            { taxCode: 'V00', ratePercent: '0' },
          ],
        },
      }),
    );
    expect(w).toEqual([]);
  });

  // ③ billing tax_code NULL → WARN (백로그 B1 종결: NULL을 과세와 같은 WARN으로)
  it('warns when a downstream billing line carries NO tax_code (NULL) — the B1 closure', () => {
    const w = exportDeclarationWarnings(
      base({ billing: { kind: 'EXISTS', lines: [{ taxCode: null, ratePercent: null }] } }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'WARN', code: 'ZERO_RATE_TAX_CODE_MISSING' });
  });

  // ③b 영세율(V00, rate 0) + NULL 혼재 → WARN. The precise B1 line: a predicate that only checked
  //     rate>0 would PASS this (both lines are rate 0 / null), so it pins "NULL grouped WITH taxable".
  it('warns on a 영세율(V00) + NULL-tax_code mix — the exact line B1 used to let slip through', () => {
    const w = exportDeclarationWarnings(
      base({
        billing: {
          kind: 'EXISTS',
          lines: [
            { taxCode: 'V00', ratePercent: '0' },
            { taxCode: null, ratePercent: null },
          ],
        },
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'WARN', code: 'ZERO_RATE_TAX_CODE_MISSING' });
  });

  // ④ billing 비영세율 (taxable, rate>0) → WARN
  it('warns when a downstream billing line is taxable (rate > 0)', () => {
    const w = exportDeclarationWarnings(
      base({
        billing: {
          kind: 'EXISTS',
          lines: [
            { taxCode: 'V00', ratePercent: '0' },
            { taxCode: 'V10', ratePercent: '10' },
          ],
        },
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'WARN', code: 'ZERO_RATE_TAX_CODE_MISSING' });
  });

  // ⑤ billing 미생성 → INFO (WARN 아님)
  it('notes INFO (not WARN) when no billing exists yet — declaration precedes the invoice', () => {
    const noBilling: BillingTaxState = { kind: 'NONE' };
    const w = exportDeclarationWarnings(base({ billing: noBilling }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'INFO', code: 'BILLING_NOT_CREATED' });
  });

  // (extra) trade_direction ≠ EXP → WARN, merged into the same array
  it('warns on a stored trade_direction other than EXP (no inference — the doc IS an export)', () => {
    const w = exportDeclarationWarnings(base({ tradeDirection: 'DOM' }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'WARN', code: 'TRADE_DIRECTION_NOT_EXP' });
  });

  // ⑥ 멱등 재생성 → 동일 warnings (pure: same input ⇒ deep-equal output)
  it('is deterministic — re-running the same input yields identical warnings', () => {
    const input = base({
      tradeDirection: 'IMP',
      items: [{ lineNo: 1, hasHsCode: false }, { lineNo: 2, hasHsCode: true }],
      billing: { kind: 'EXISTS', lines: [{ taxCode: null, ratePercent: null }] },
    });
    expect(exportDeclarationWarnings(input)).toEqual(exportDeclarationWarnings(input));
    // and the merge order is stable: G0 (direction) → G1 (HS) → G2 (billing).
    const codes = exportDeclarationWarnings(input).map((x) => x.code);
    expect(codes).toEqual(['TRADE_DIRECTION_NOT_EXP', 'HS_CODE_MISSING', 'ZERO_RATE_TAX_CODE_MISSING']);
  });
});
