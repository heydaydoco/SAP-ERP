import { describe, expect, it } from 'vitest';
import {
  drawbackClaimWarnings,
  type DrawbackLineGateState,
} from './duty-drawback-warnings.js';

/** A fully-clean line: ACCEPTED, HS present + rate matched, far-off deadline, no manual deviation. */
const cleanLine = (over: Partial<DrawbackLineGateState> = {}): DrawbackLineGateState => ({
  lineNo: 1,
  sourceStatus: 'ACCEPTED',
  acceptanceDate: '2026-01-10',
  hsMissing: false,
  rateMatched: true,
  manualFobDeviation: null,
  ...over,
});

const codes = (input: Parameters<typeof drawbackClaimWarnings>[0]) =>
  drawbackClaimWarnings(input).map((w) => w.code);

describe('duty-drawback-warnings (§5.4) — all SOFT, never throws', () => {
  it('a fully-consistent line emits no warnings', () => {
    expect(drawbackClaimWarnings({ claimDate: '2026-06-01', lines: [cleanLine()] })).toEqual([]);
  });

  it('G0 — source not ACCEPTED (수리 전) → SOURCE_NOT_ACCEPTED', () => {
    expect(codes({ claimDate: '2026-06-01', lines: [cleanLine({ sourceStatus: 'SUBMITTED' })] })).toContain(
      'SOURCE_NOT_ACCEPTED',
    );
  });

  it('G1 — no 간이정액률 matched → SIMPLIFIED_RATE_NOT_FOUND (still soft, calc proceeds at 0)', () => {
    expect(codes({ claimDate: '2026-06-01', lines: [cleanLine({ rateMatched: false })] })).toContain(
      'SIMPLIFIED_RATE_NOT_FOUND',
    );
  });

  it('G1 — a missing source HS → SOURCE_HS_MISSING (root cause), NOT the rate-table warning', () => {
    const c = codes({
      claimDate: '2026-06-01',
      lines: [cleanLine({ hsMissing: true, rateMatched: false })],
    });
    expect(c).toContain('SOURCE_HS_MISSING');
    expect(c).not.toContain('SIMPLIFIED_RATE_NOT_FOUND'); // HS is the root cause; not double-warned
  });

  it('G2 — missing 수리일 → ACCEPTANCE_DATE_MISSING (no deadline classification)', () => {
    const c = codes({ claimDate: '2026-06-01', lines: [cleanLine({ acceptanceDate: null })] });
    expect(c).toContain('ACCEPTANCE_DATE_MISSING');
    expect(c).not.toContain('REFUND_DEADLINE_EXCEEDED');
    expect(c).not.toContain('REFUND_DEADLINE_APPROACHING');
  });

  it('G2 — 환급기한 (수리일 + 2년) exceeded → REFUND_DEADLINE_EXCEEDED', () => {
    // 수리일 2026-01-10 + 2년 = 2028-01-10; a 2028-02-01 claim is past it.
    expect(
      codes({ claimDate: '2028-02-01', lines: [cleanLine({ acceptanceDate: '2026-01-10' })] }),
    ).toContain('REFUND_DEADLINE_EXCEEDED');
  });

  it('G2 — within 60 days of the 환급기한 → REFUND_DEADLINE_APPROACHING', () => {
    // deadline 2028-01-10; a 2027-12-01 claim is ~40 days before → 임박.
    const c = codes({ claimDate: '2027-12-01', lines: [cleanLine({ acceptanceDate: '2026-01-10' })] });
    expect(c).toContain('REFUND_DEADLINE_APPROACHING');
    expect(c).not.toContain('REFUND_DEADLINE_EXCEEDED');
  });

  it('G2 — comfortably before the deadline → no deadline warning', () => {
    const c = codes({ claimDate: '2026-06-01', lines: [cleanLine({ acceptanceDate: '2026-01-10' })] });
    expect(c).not.toContain('REFUND_DEADLINE_APPROACHING');
    expect(c).not.toContain('REFUND_DEADLINE_EXCEEDED');
  });

  it('G2 — leap-day 수리일 clamps (02-29 + 2년 → 02-28 in a non-leap year), no crash', () => {
    // 수리일 2028-02-29 (leap) + 2년 = 2030-02-28; a 2030-02-27 claim is 1 day before → 임박.
    const c = codes({ claimDate: '2030-02-27', lines: [cleanLine({ acceptanceDate: '2028-02-29' })] });
    expect(c).toContain('REFUND_DEADLINE_APPROACHING');
  });

  it('G3 — manual 원화 FOB deviation → MANUAL_FOB_KRW_DEVIATION (only when true)', () => {
    expect(codes({ claimDate: '2026-06-01', lines: [cleanLine({ manualFobDeviation: true })] })).toContain(
      'MANUAL_FOB_KRW_DEVIATION',
    );
    expect(
      codes({ claimDate: '2026-06-01', lines: [cleanLine({ manualFobDeviation: false })] }),
    ).not.toContain('MANUAL_FOB_KRW_DEVIATION');
  });

  it('stacks multiple warnings on one line, all WARN, with the line number', () => {
    const ws = drawbackClaimWarnings({
      claimDate: '2028-02-01',
      lines: [cleanLine({ sourceStatus: 'SUBMITTED', rateMatched: false, acceptanceDate: '2026-01-10' })],
    });
    expect(ws.map((w) => w.code)).toEqual([
      'SOURCE_NOT_ACCEPTED',
      'SIMPLIFIED_RATE_NOT_FOUND',
      'REFUND_DEADLINE_EXCEEDED',
    ]);
    expect(ws.every((w) => w.severity === 'WARN' && w.lineNo === 1)).toBe(true);
  });
});
