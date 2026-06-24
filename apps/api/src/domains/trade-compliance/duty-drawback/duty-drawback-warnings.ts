import {
  DRAWBACK_DEADLINE_WARN_DAYS,
  DRAWBACK_DEADLINE_YEARS,
} from '../trade-compliance.constants.js';

/**
 * Duty-drawback consistency gate (§5.4) — a PURE classifier, ALL warnings SOFT (never blocks): the service
 * always creates the claim and returns these in `warnings[]`. Mirrors export/import-declaration-warnings.
 * The premise is the claim ITSELF (filing a 환급신청 is the explicit act); the gate only checks consistency,
 * per line, deterministically (G0 → G1 → G2 → G3):
 *
 *   G0 source 수리 상태  — the source 수출신고 is not ACCEPTED (수리 전) → WARN (refund needs an accepted export).
 *   G1 간이정액률 누락    — the source line has NO HS (률 결정 불가) → SOURCE_HS_MISSING; else no 간이정액환급률
 *                          matched the HS on the 수리일 → SIMPLIFIED_RATE_NOT_FOUND. Either way 률=0 진행 (soft).
 *   G2 환급기한          — 환급기한 = 수리일 + 2년; the 수리일 is missing → WARN · claim_date 초과 → WARN ·
 *                          claim_date 임박 (≤ DRAWBACK_DEADLINE_WARN_DAYS days) → WARN.
 *   G3 수동 FOB 편차     — a manual 원화 FOB deviates from the auto-converted KRW beyond max(1,000원, 1%) → WARN.
 *
 * trade_direction is never checked here (a 수출신고 is already EXP). None is a hard error.
 */

export type DrawbackWarningSeverity = 'WARN' | 'INFO';

export interface DrawbackClaimWarning {
  severity: DrawbackWarningSeverity;
  /** Stable machine code (e.g. 'SIMPLIFIED_RATE_NOT_FOUND') for the UI / tests; the message is human-facing. */
  code: string;
  message: string;
  /** 1-based item line number (all drawback gates are line-level). */
  lineNo: number;
}

/** Per-line facts the service resolved, fed to the pure gate. */
export interface DrawbackLineGateState {
  lineNo: number;
  /** export_declaration.status of the source (G0 — refund expects 'ACCEPTED'). */
  sourceStatus: string;
  /** export_declaration.acceptance_date (수리일) of the source; null when the export is not yet 수리 (G2). */
  acceptanceDate: string | null;
  /** Did the source export line carry NO HS code (G1 root cause — 률 결정 불가)? */
  hsMissing: boolean;
  /** Did a 간이정액환급률 match the line's HS on the 수리일 (G1)? */
  rateMatched: boolean;
  /**
   * G3: did a manual 원화 FOB deviate from the auto-converted KRW beyond tolerance? `null` = not applicable
   * (no manual override, or no auto value because the source currency has no 수리일 rate).
   */
  manualFobDeviation: boolean | null;
}

export interface DrawbackWarningInput {
  /** 환급신청일 — the G2 deadline reference. */
  claimDate: string;
  lines: readonly DrawbackLineGateState[];
}

/** UTC day index of a YYYY-MM-DD string (pure; no "now"). */
function toUtcDays(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/** YYYY-MM-DD + `years`, clamping an out-of-range day (e.g. 02-29 → 02-28 in a non-leap year). Pure. */
function addYearsClamped(iso: string, years: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const targetY = (y ?? 1970) + years;
  const month = m ?? 1;
  const lastDay = new Date(Date.UTC(targetY, month, 0)).getUTCDate(); // day 0 of next month = last day
  const day = Math.min(d ?? 1, lastDay);
  return `${targetY}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function drawbackClaimWarnings(input: DrawbackWarningInput): DrawbackClaimWarning[] {
  const warnings: DrawbackClaimWarning[] = [];

  for (const line of input.lines) {
    // G0 — the source 수출신고 must be 수리(ACCEPTED) for a refund.
    if (line.sourceStatus !== 'ACCEPTED') {
      warnings.push({
        severity: 'WARN',
        code: 'SOURCE_NOT_ACCEPTED',
        message: `line ${line.lineNo}: 원천 수출신고가 수리(ACCEPTED) 상태가 아님 (${line.sourceStatus}) — 환급 대상 아님`,
        lineNo: line.lineNo,
      });
    }

    // G1 — 률 결정 불가. A missing source HS is the root cause (distinct, clearer code); otherwise the HS is
    // present but no 간이정액률 matched (개별환급 대상/률표 누락). Either way the line proceeds with 률=0 (soft).
    if (line.hsMissing) {
      warnings.push({
        severity: 'WARN',
        code: 'SOURCE_HS_MISSING',
        message: `line ${line.lineNo}: 원천 수출신고 라인에 HS코드 없음 — 간이정액환급률 결정 불가, 환급액 0으로 계산`,
        lineNo: line.lineNo,
      });
    } else if (!line.rateMatched) {
      warnings.push({
        severity: 'WARN',
        code: 'SIMPLIFIED_RATE_NOT_FOUND',
        message: `line ${line.lineNo}: 간이정액환급률 미존재 (HS/수리일 구간) — 개별환급 대상 또는 률표 누락, 환급액 0으로 계산`,
        lineNo: line.lineNo,
      });
    }

    // G2 — 환급기한 (수리일 + 2년).
    if (line.acceptanceDate == null) {
      warnings.push({
        severity: 'WARN',
        code: 'ACCEPTANCE_DATE_MISSING',
        message: `line ${line.lineNo}: 원천 수출신고 수리일 미존재 — 환급기한·환율기준일 산정 불가`,
        lineNo: line.lineNo,
      });
    } else {
      const deadline = addYearsClamped(line.acceptanceDate, DRAWBACK_DEADLINE_YEARS);
      const daysToDeadline = toUtcDays(deadline) - toUtcDays(input.claimDate);
      if (daysToDeadline < 0) {
        warnings.push({
          severity: 'WARN',
          code: 'REFUND_DEADLINE_EXCEEDED',
          message: `line ${line.lineNo}: 환급기한 초과 — 수리일 ${line.acceptanceDate} + 2년 (${deadline}) 이전 신청 필요`,
          lineNo: line.lineNo,
        });
      } else if (daysToDeadline <= DRAWBACK_DEADLINE_WARN_DAYS) {
        warnings.push({
          severity: 'WARN',
          code: 'REFUND_DEADLINE_APPROACHING',
          message: `line ${line.lineNo}: 환급기한 임박 (${deadline}까지 ${daysToDeadline}일) — 조속 신청 필요`,
          lineNo: line.lineNo,
        });
      }
    }

    // G3 — manual 원화 FOB deviates from the auto-converted KRW beyond max(1,000원, 1%).
    if (line.manualFobDeviation === true) {
      warnings.push({
        severity: 'WARN',
        code: 'MANUAL_FOB_KRW_DEVIATION',
        message: `line ${line.lineNo}: 수동 원화 FOB가 수리일 환산값과 허용오차(max 1,000원·1%) 초과 — 입력 확인 필요`,
        lineNo: line.lineNo,
      });
    }
  }

  return warnings;
}
