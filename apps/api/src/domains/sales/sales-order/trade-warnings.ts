/**
 * Trade-direction sanity warnings (§5) — SOFT, never blocking. A pure classifier over the resolved SO
 * lines. `trade_direction` NEVER determines the VAT rate (the line `tax_code` does) — this only
 * inspects for a likely mistake and warns; it changes no posting.
 *
 * The ONLY contradiction worth flagging is an EXPORT (EXP) line carrying a TAXABLE (rate > 0) output VAT
 * code: an export should be zero-rated (영세율, e.g. V00). Deliberately NOT flagged:
 *   - DOM + V00 (0%) — legitimate domestic zero-rate (내국신용장/구매확인서) — must pass clean.
 *   - DOM + taxable — ordinary domestic sale.
 *   - EXP + V00 / no tax code — correct export.
 *   - IMP / null direction — not tax-relevant on a sales order here.
 */

export interface TradeWarningLine {
  lineNo: number;
  taxCode: string | null;
  /** Resolved VAT rate in percentage points ('10', '0', …); null when the line carries no tax code. */
  ratePercent: string | null;
}

export function exportTaxWarnings(
  tradeDirection: string | null | undefined,
  lines: readonly TradeWarningLine[],
): string[] {
  if (tradeDirection !== 'EXP') return [];
  const warnings: string[] = [];
  for (const line of lines) {
    if (line.ratePercent != null && Number(line.ratePercent) > 0) {
      warnings.push(
        `line ${line.lineNo}: export (EXP) order carries taxable VAT code ${line.taxCode} ` +
          `(${line.ratePercent}%) — exports are normally zero-rated (영세율, e.g. V00)`,
      );
    }
  }
  return warnings;
}
