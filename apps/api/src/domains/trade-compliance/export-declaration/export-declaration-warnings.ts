/**
 * Export-declaration consistency gate (§5.4) — a PURE classifier, ALL warnings SOFT (never blocks): the
 * service always creates the declaration and returns these in `warnings[]`. The export premise is the
 * declaration ITSELF — creating an `export_declaration` is an explicit 수출 declaration; the gate NEVER
 * infers export-ness from `trade_direction`, it only checks consistency on that premise.
 *
 *   G0 trade_direction — a stored direction other than EXP contradicts the declaration → WARN.
 *   G1 HS code         — an item line with no HS code (DTO nor material_trade) → WARN, per line
 *                        (품목분류 needed for 수출신고 accuracy).
 *   G2 영세율 증빙       — the declared delivery's downstream billing tax codes (read-only):
 *        · all 영세율 (rate 0)                       → no warning (the declaration backs the zero-rated sale)
 *        · billing exists with a NULL OR taxable(rate>0) line → WARN. Grouping NULL WITH taxable is the
 *          point: a billing line that carries NO tax_code used to slip through silently (backlog B1) —
 *          영세율 is allowed ONLY by an explicit tax_code, so a missing one risks 과세 추징. One WARN closes it.
 *        · no billing yet                            → INFO (신고가 인보이스보다 선행 — a normal state).
 *
 * Severity is surfaced (WARN vs INFO) so the caller/UI can rank them; none is a hard error.
 */

export type ExportWarningSeverity = 'WARN' | 'INFO';

export interface ExportDeclarationWarning {
  severity: ExportWarningSeverity;
  /** Stable machine code (e.g. 'HS_CODE_MISSING') for the UI / tests; the message is human-facing. */
  code: string;
  message: string;
  /** 1-based item line number for a line-level warning (G1); omitted for header/billing-level ones. */
  lineNo?: number;
}

/** Per-item HS resolution: did the line end up with an HS code (DTO `hsCode` ?? `material_trade.hs_code`)? */
export interface ExportItemHsState {
  lineNo: number;
  hasHsCode: boolean;
}

/**
 * Downstream-billing tax snapshot for G2, resolved READ-ONLY from the declared delivery's sales order.
 * `NONE` = no billing exists yet. `EXISTS` carries each billing line's resolved tax: `ratePercent` is the
 * tax_code master rate ('0' for 영세율 V00), `null` when the line carries NO tax_code at all.
 */
export type BillingTaxState =
  | { kind: 'NONE' }
  | {
      kind: 'EXISTS';
      lines: readonly { taxCode: string | null; ratePercent: string | null }[];
    };

export interface ExportDeclarationWarningInput {
  /** Stored header trade_direction (EXP by default); a non-EXP value contradicts an export declaration. */
  tradeDirection: string | null | undefined;
  items: readonly ExportItemHsState[];
  billing: BillingTaxState;
}

export function exportDeclarationWarnings(
  input: ExportDeclarationWarningInput,
): ExportDeclarationWarning[] {
  const warnings: ExportDeclarationWarning[] = [];

  // G0 — trade_direction contradiction (no inference; the document IS an export).
  if (input.tradeDirection != null && input.tradeDirection !== 'EXP') {
    warnings.push({
      severity: 'WARN',
      code: 'TRADE_DIRECTION_NOT_EXP',
      message: `trade_direction ${input.tradeDirection} 는 수출신고와 모순됩니다 — 수출신고의 거래구분은 EXP가 정상`,
    });
  }

  // G1 — HS code missing, per line.
  for (const item of input.items) {
    if (!item.hasHsCode) {
      warnings.push({
        severity: 'WARN',
        code: 'HS_CODE_MISSING',
        message: `line ${item.lineNo}: HS코드 미등록 — 품목분류 필요, 수출신고 정확성 위험`,
        lineNo: item.lineNo,
      });
    }
  }

  // G2 — 영세율 증빙 (downstream billing tax consistency).
  if (input.billing.kind === 'NONE') {
    warnings.push({
      severity: 'INFO',
      code: 'BILLING_NOT_CREATED',
      message: '빌링 미생성 — 빌링 시 영세율 tax_code 명시 부여 필요 (신고가 인보이스보다 선행, 정상 상태)',
    });
  } else {
    // A billing line is non-compliant when it carries NO tax_code (NULL) OR a taxable (rate > 0) code.
    // A 영세율 line is ONLY one with an explicit tax_code at rate 0 — so NULL is grouped WITH taxable (B1).
    const compliant = (line: { taxCode: string | null; ratePercent: string | null }): boolean =>
      line.taxCode != null && line.ratePercent != null && Number(line.ratePercent) === 0;
    if (input.billing.lines.some((line) => !compliant(line))) {
      warnings.push({
        severity: 'WARN',
        code: 'ZERO_RATE_TAX_CODE_MISSING',
        message:
          '수출 거래에 영세율 세금코드 미적용 — 영세율은 tax_code 명시 부여만 허용, 미지정 시 과세 추징 위험',
      });
    }
  }

  return warnings;
}
