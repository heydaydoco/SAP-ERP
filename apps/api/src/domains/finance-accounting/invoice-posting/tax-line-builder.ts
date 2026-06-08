import { Money } from '@erp/kernel';

/**
 * Invoice VAT line builder — the AR/AP shared tax calc path (root CLAUDE.md §5.4, mandatory-tested).
 *
 * Pure function over the kernel {@link Money} value object: no DB, no I/O, no clock. Given an
 * invoice's net (exclusive) lines and the resolved tax codes they reference, it produces the VAT
 * journal lines and the document totals. Two locked decisions live here:
 *
 *  - **D1 — round PER LINE, then aggregate per tax code.** The VAT for each line is rounded to the
 *    currency's minor unit on its own (kernel `Money.percentage`), and the per-line amounts are
 *    SUMMED into one journal line per tax code. So the GL VAT line equals Σ(per-line 세액), which is
 *    by construction the 전자세금계산서 합계세액 — rounding the document total once instead drifts by ±1
 *    minor unit against an itemised tax invoice (e.g. 3×1,235 @10% → 372, not 371).
 *  - **D2 — half-away rounding (kernel default).** Truncation (절사) is a per-counterparty option
 *    exposed as the {@link TaxRounding} parameter; wiring it to a master-data flag is a later slice,
 *    so callers pass `'HALF_UP'` today. Both modes are implemented and unit-tested here.
 */

/** Rounding of each line's VAT to the base currency's minor unit (D2). */
export type TaxRounding = 'HALF_UP' | 'TRUNCATE';

/** One invoice line's taxable base and the tax code that applies (absent ⇒ the line carries no VAT). */
export interface TaxableLine {
  readonly net: Money;
  readonly taxCode?: string;
}

/** The resolved tax-code master a build needs: its rate and the VAT GL account its line posts to. */
export interface TaxCodeInfo {
  readonly code: string;
  /** Percentage points, e.g. '10' for 10% (master `tax_code.rate_percent`). */
  readonly ratePercent: string;
  /** Output-VAT (AR) / input-VAT (AP) GL account the aggregated line posts to. */
  readonly glAccount: string;
}

/** One aggregated VAT line: the Σ of the per-line rounded taxes sharing this tax code (D1). */
export interface AggregatedTaxLine {
  readonly taxCode: string;
  readonly glAccount: string;
  readonly ratePercent: string;
  /** Σ net of the lines under this tax code. */
  readonly base: Money;
  /** Σ of each line's individually-rounded VAT (D1). */
  readonly tax: Money;
}

export interface TaxComputation {
  /** One line per tax code that produced VAT, ordered by first appearance in the input. */
  readonly taxLines: readonly AggregatedTaxLine[];
  readonly totalNet: Money;
  readonly totalTax: Money;
  /** Gross = net + tax; the amount the receivable/payable recon line carries. */
  readonly grandTotal: Money;
}

/** `tax_code.rate_percent` shape: up to 3 integer + 4 fraction digits, non-negative. */
const RATE_RE = /^\d{1,3}(\.\d{1,4})?$/;

/**
 * VAT for one line, rounded to the base currency's minor unit. `HALF_UP` delegates to the kernel so
 * rate rounding lives in one place; `TRUNCATE` floors toward zero (nets are non-negative) using the
 * same minor-unit math, for the future per-counterparty 절사 flag.
 */
function lineTax(net: Money, ratePercent: string, rounding: TaxRounding): Money {
  if (rounding === 'HALF_UP') return net.percentage(ratePercent);
  const str = ratePercent.trim();
  if (!RATE_RE.test(str)) throw new Error(`invalid percentage: "${ratePercent}"`);
  const [intPart = '0', fracPart = ''] = str.split('.');
  const numerator = BigInt(intPart + fracPart);
  const denominator = 100n * 10n ** BigInt(fracPart.length);
  return net.withMinorUnits((net.minorUnits * numerator) / denominator);
}

/**
 * Build the VAT lines and totals for an invoice. Throws if a referenced tax code is missing from
 * `taxCodes`, or if a line's currency or sign is invalid — the caller (AR/AP service) resolves the
 * codes and validates the partner first, so by here every code is present and every net is ≥ 0.
 */
export function buildTaxLines(
  lines: readonly TaxableLine[],
  taxCodes: ReadonlyMap<string, TaxCodeInfo>,
  rounding: TaxRounding = 'HALF_UP',
): TaxComputation {
  const first = lines[0];
  if (!first) throw new Error('an invoice needs at least one line');
  const { currency } = first.net;
  const zero = first.net.withMinorUnits(0n);

  const order: string[] = [];
  const byCode = new Map<string, { info: TaxCodeInfo; base: Money; tax: Money }>();
  let totalNet = zero;

  for (const line of lines) {
    if (line.net.currency !== currency) {
      throw new Error(`invoice line currency ${line.net.currency} differs from ${currency}`);
    }
    if (line.net.sign < 0) throw new Error('invoice line net must be non-negative');
    totalNet = totalNet.add(line.net);

    if (line.taxCode === undefined) continue;
    const info = taxCodes.get(line.taxCode);
    if (!info) throw new Error(`tax code ${line.taxCode} not resolved`);

    let entry = byCode.get(line.taxCode);
    if (!entry) {
      entry = { info, base: zero, tax: zero };
      byCode.set(line.taxCode, entry);
      order.push(line.taxCode);
    }
    entry.base = entry.base.add(line.net);
    // D1: accumulate the per-line rounded tax, never the rounding of a running total.
    entry.tax = entry.tax.add(lineTax(line.net, info.ratePercent, rounding));
  }

  const taxLines = order.map((code) => {
    const e = byCode.get(code);
    if (!e) throw new Error(`tax code ${code} vanished during aggregation`);
    return {
      taxCode: code,
      glAccount: e.info.glAccount,
      ratePercent: e.info.ratePercent,
      base: e.base,
      tax: e.tax,
    };
  });

  const totalTax = taxLines.reduce((sum, t) => sum.add(t.tax), zero);
  return { taxLines, totalNet, totalTax, grandTotal: totalNet.add(totalTax) };
}
