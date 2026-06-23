import { describe, expect, it } from 'vitest';
import {
  importDeclarationWarnings,
  type ImportDeclarationWarningInput,
} from './import-declaration-warnings.js';

/**
 * Import-declaration consistency gate (§5.4) — pure, all SOFT. Covers the required scenarios:
 * G0 거래구분 ≠ IMP → WARN · G1 HS 누락 → WARN(라인) · G2 원산지 누락 → WARN(라인) ·
 * G3a 과세가격 불일치 → WARN · G3b 관세액 괴리 → INFO · 정상 → 무경고 · 멱등(deterministic) + merge 순서.
 */
describe('importDeclarationWarnings', () => {
  const base = (over: Partial<ImportDeclarationWarningInput> = {}): ImportDeclarationWarningInput => ({
    tradeDirection: 'IMP',
    items: [{ lineNo: 1, hasHsCode: true, hasOrigin: true }],
    customsValue: { headerDeclared: '1000.0000', lineSum: '1000.0000', matches: true },
    duty: null,
    ...over,
  });

  it('emits NO warning for a clean declaration', () => {
    expect(importDeclarationWarnings(base())).toEqual([]);
  });

  // G1 — HS 누락 (per line)
  it('warns per item line missing an HS code', () => {
    const w = importDeclarationWarnings(
      base({
        items: [
          { lineNo: 1, hasHsCode: true, hasOrigin: true },
          { lineNo: 2, hasHsCode: false, hasOrigin: true },
        ],
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'WARN', code: 'HS_CODE_MISSING', lineNo: 2 });
    expect(w[0]!.message).toContain('HS코드');
  });

  // G2 — 원산지 누락 (per line, import-specific)
  it('warns per item line missing an origin country', () => {
    const w = importDeclarationWarnings(
      base({
        items: [
          { lineNo: 1, hasHsCode: true, hasOrigin: true },
          { lineNo: 2, hasHsCode: true, hasOrigin: false },
        ],
      }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'WARN', code: 'ORIGIN_COUNTRY_MISSING', lineNo: 2 });
    expect(w[0]!.message).toContain('원산지');
  });

  // G1 + G2 on the SAME line → two warnings, HS before origin.
  it('warns on both HS and origin when a line lacks each (HS before origin)', () => {
    const w = importDeclarationWarnings(
      base({ items: [{ lineNo: 1, hasHsCode: false, hasOrigin: false }] }),
    );
    expect(w.map((x) => x.code)).toEqual(['HS_CODE_MISSING', 'ORIGIN_COUNTRY_MISSING']);
  });

  // G0 — trade_direction ≠ IMP → WARN (no inference — the doc IS an import)
  it('warns on a stored trade_direction other than IMP', () => {
    const w = importDeclarationWarnings(base({ tradeDirection: 'EXP' }));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'WARN', code: 'TRADE_DIRECTION_NOT_IMP' });
  });

  // G3a — 과세가격 불일치 → WARN
  it('warns when the line sum 과세가격 ≠ the declared header 과세가격', () => {
    const w = importDeclarationWarnings(
      base({ customsValue: { headerDeclared: '1000.0000', lineSum: '900.0000', matches: false } }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'WARN', code: 'CUSTOMS_VALUE_LINE_SUM_MISMATCH' });
    expect(w[0]!.message).toContain('900.0000');
  });

  // G3b — 관세액 괴리 → INFO (참고용, 비차단)
  it('notes INFO (not WARN) when the declared duty deviates from the estimate', () => {
    const w = importDeclarationWarnings(
      base({ duty: { declared: '50.0000', expected: '80.0000', withinTolerance: false } }),
    );
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: 'INFO', code: 'DUTY_AMOUNT_SANITY' });
  });

  it('emits NO duty note when the duty is within tolerance', () => {
    const w = importDeclarationWarnings(
      base({ duty: { declared: '80.0000', expected: '80.0000', withinTolerance: true } }),
    );
    expect(w).toEqual([]);
  });

  it('skips G3b entirely when duty is not estimable (null)', () => {
    const w = importDeclarationWarnings(base({ duty: null }));
    expect(w).toEqual([]);
  });

  // Deterministic + stable merge order: G0 → G1 → G2 → G3a → G3b.
  it('is deterministic and merges in a stable order', () => {
    const input = base({
      tradeDirection: 'DOM',
      items: [{ lineNo: 1, hasHsCode: false, hasOrigin: false }],
      customsValue: { headerDeclared: '1000.0000', lineSum: '900.0000', matches: false },
      duty: { declared: '50.0000', expected: '80.0000', withinTolerance: false },
    });
    expect(importDeclarationWarnings(input)).toEqual(importDeclarationWarnings(input));
    expect(importDeclarationWarnings(input).map((x) => x.code)).toEqual([
      'TRADE_DIRECTION_NOT_IMP',
      'HS_CODE_MISSING',
      'ORIGIN_COUNTRY_MISSING',
      'CUSTOMS_VALUE_LINE_SUM_MISMATCH',
      'DUTY_AMOUNT_SANITY',
    ]);
  });
});
