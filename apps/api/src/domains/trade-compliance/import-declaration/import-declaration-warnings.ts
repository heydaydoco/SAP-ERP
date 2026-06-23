/**
 * Import-declaration consistency gate (§5.4) — a PURE classifier, ALL warnings SOFT (never blocks): the
 * service always creates the declaration and returns these in `warnings[]`. The import premise is the
 * declaration ITSELF — creating an `import_declaration` is an explicit 수입 declaration; the gate NEVER
 * infers import-ness from `trade_direction`, it only checks consistency on that premise (symmetric to the
 * export gate).
 *
 *   G0 trade_direction — a stored direction other than IMP contradicts the declaration → WARN.
 *   G1 HS code         — an item line with no HS code (DTO nor material_trade) → WARN, per line
 *                        (품목분류 needed for 수입신고 accuracy).
 *   G2 원산지           — an item line with no origin country → WARN, per line. ADDED over the export gate:
 *                        on import, 원산지 drives the 관세율 / FTA 특혜관세 / 원산지표시 judgement directly.
 *   G3a 과세가격 정합    — Σ line 과세가격 ≠ the declared header 과세가격 → WARN.
 *   G3b 관세액 정합      — declared 관세액 deviates from (과세가격 × 관세율) beyond tolerance → INFO (참고용,
 *                        비차단). Skipped (null `duty`) when not every line declares a rate.
 *
 * Severity is surfaced (WARN vs INFO) so the caller/UI can rank them; none is a hard error. Import
 * accounting (관세 + 수입부가세 재고원가 배부) is the landed-cost document's job — this gate never posts.
 */

export type ImportWarningSeverity = 'WARN' | 'INFO';

export interface ImportDeclarationWarning {
  severity: ImportWarningSeverity;
  /** Stable machine code (e.g. 'HS_CODE_MISSING') for the UI / tests; the message is human-facing. */
  code: string;
  message: string;
  /** 1-based item line number for a line-level warning (G1/G2); omitted for header-level ones. */
  lineNo?: number;
}

/** Per-item resolution: did the line end up with an HS code / an origin country (DTO ?? material_trade)? */
export interface ImportItemState {
  lineNo: number;
  hasHsCode: boolean;
  hasOrigin: boolean;
}

/** G3a input — the declared header 과세가격 vs the Money-exact line sum, with the pre-computed match flag. */
export interface ImportCustomsValueState {
  headerDeclared: string;
  lineSum: string;
  matches: boolean;
}

/** G3b input — the declared 관세액 vs the estimate, with the pre-computed tolerance flag (service-computed). */
export interface ImportDutyState {
  declared: string;
  expected: string;
  withinTolerance: boolean;
}

export interface ImportDeclarationWarningInput {
  /** Stored header trade_direction (IMP by default); a non-IMP value contradicts an import declaration. */
  tradeDirection: string | null | undefined;
  items: readonly ImportItemState[];
  customsValue: ImportCustomsValueState;
  /** Duty-sanity inputs, or `null` when not every line declares a rate (G3b skipped). */
  duty: ImportDutyState | null;
}

export function importDeclarationWarnings(
  input: ImportDeclarationWarningInput,
): ImportDeclarationWarning[] {
  const warnings: ImportDeclarationWarning[] = [];

  // G0 — trade_direction contradiction (no inference; the document IS an import).
  if (input.tradeDirection != null && input.tradeDirection !== 'IMP') {
    warnings.push({
      severity: 'WARN',
      code: 'TRADE_DIRECTION_NOT_IMP',
      message: `trade_direction ${input.tradeDirection} 는 수입신고와 모순됩니다 — 수입신고의 거래구분은 IMP가 정상`,
    });
  }

  // G1 — HS code missing, per line.
  for (const item of input.items) {
    if (!item.hasHsCode) {
      warnings.push({
        severity: 'WARN',
        code: 'HS_CODE_MISSING',
        message: `line ${item.lineNo}: HS코드 미등록 — 품목분류 필요, 수입신고 정확성 위험`,
        lineNo: item.lineNo,
      });
    }
  }

  // G2 — 원산지 missing, per line (import-specific: 원산지 drives 관세율 / FTA / 원산지표시).
  for (const item of input.items) {
    if (!item.hasOrigin) {
      warnings.push({
        severity: 'WARN',
        code: 'ORIGIN_COUNTRY_MISSING',
        message: `line ${item.lineNo}: 원산지 미기재 — FTA 특혜관세/원산지표시 판단 불가`,
        lineNo: item.lineNo,
      });
    }
  }

  // G3a — 과세가격 정합 (declared header total vs the Money-exact line sum).
  if (!input.customsValue.matches) {
    warnings.push({
      severity: 'WARN',
      code: 'CUSTOMS_VALUE_LINE_SUM_MISMATCH',
      message: `과세가격 불일치 — 라인 합계 ${input.customsValue.lineSum} ≠ 헤더 신고 ${input.customsValue.headerDeclared}`,
    });
  }

  // G3b — 관세액 정합 (declared duty vs 과세가격 × 관세율 estimate). INFO only — 참고용, 비차단.
  if (input.duty != null && !input.duty.withinTolerance) {
    warnings.push({
      severity: 'INFO',
      code: 'DUTY_AMOUNT_SANITY',
      message: `관세액 점검 — 신고 ${input.duty.declared} vs 추정(과세가격×관세율) ${input.duty.expected} 괴리 (참고)`,
    });
  }

  return warnings;
}
