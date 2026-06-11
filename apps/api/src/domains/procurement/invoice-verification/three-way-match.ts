import { formatScaled6 } from '../../inventory-warehouse/inventory/map.js';

/**
 * 3-way match — pure tolerance math (root CLAUDE.md §5.4: matching logic gets mandatory unit tests;
 * wrong math = wrong money). PO ↔ goods receipt ↔ vendor invoice are reconciled at PO-item
 * granularity. No DB, no I/O, no clock: the service resolves the aggregates (Σ received, Σ already
 * invoiced) and calls this; the function decides whether this invoice line may post.
 *
 * Quantities and unit prices are exact **scale-6 fixed-point bigints** mirroring `NUMERIC(18,6)`
 * (same representation as the MAP math, `inventory/map.ts`).
 *
 * Two checks, both within tolerance:
 *  - **Quantity** — an invoice may bill only what has been RECEIVED and not yet invoiced
 *    (`Σreceived − Σinvoiced`, + a quantity tolerance). Invoicing more than received is blocked
 *    (GR-based IV; over-/under-delivery against the PO order qty is governed at goods receipt).
 *  - **Price** — the invoice unit price must sit within an absolute OR relative tolerance of the PO
 *    price; beyond it the line is blocked. Within tolerance it posts, and (Option A in this slice)
 *    the variance simply flows through GR/IR as the invoiced net. GR/IR nets to zero only when the
 *    GR and IV quantities ALIGN: because each partial GR/IV line is valued and rounded independently
 *    to the functional minor unit, asymmetric partial splits on a fractional unit price leave a
 *    GR/IR rounding residue (≈½ a minor unit per partial line, so it can reach a few units across
 *    many partials), and a price variance leaves a larger WRX residue. Both are genuine GR/IR dust —
 *    every journal stays balanced and inventory↔GL recon stays 0 — cleared by the follow-up PRD/MR11
 *    slice (Option B).
 */

/** Match tolerances. `qtyAbs6`/`priceAbs6` are scale-6 absolutes; `pricePctBp` is basis points. */
export interface MatchTolerance {
  /** Absolute quantity tolerance (scale-6). */
  qtyAbs6: bigint;
  /** Absolute per-unit price tolerance (scale-6). */
  priceAbs6: bigint;
  /** Relative price tolerance in basis points of the PO price (100 = 1%). */
  pricePctBp: bigint;
}

/**
 * Default tolerances (this slice; admin-config maintenance is a follow-up): quantity must not exceed
 * received-not-invoiced exactly, price may vary up to ±1% of the PO price.
 */
export const DEFAULT_MATCH_TOLERANCE: MatchTolerance = {
  qtyAbs6: 0n,
  priceAbs6: 0n,
  pricePctBp: 100n,
};

export interface ThreeWayMatchInput {
  /** Agreed PO unit price (scale-6). */
  poUnitPrice6: bigint;
  /** Σ quantity received against this PO item (scale-6). */
  receivedQty6: bigint;
  /** Σ quantity already invoiced against this PO item by prior IVs (scale-6). */
  invoicedQty6: bigint;
  /** Quantity this invoice line bills (scale-6). */
  thisInvoicedQty6: bigint;
  /** Unit price on this invoice line (scale-6). */
  thisInvoiceUnitPrice6: bigint;
  tolerance?: MatchTolerance;
}

export interface ThreeWayMatchResult {
  ok: boolean;
  /** Human-readable block reasons (empty when ok). */
  reasons: string[];
  /** Quantity received but not yet invoiced BEFORE this invoice (scale-6) — `Σreceived − Σinvoiced`. */
  openToInvoiceQty6: bigint;
}

const absBig = (x: bigint): bigint => (x < 0n ? -x : x);

/** Evaluate one PO-item line against its received/invoiced aggregates and the invoice line. */
export function matchThreeWay(input: ThreeWayMatchInput): ThreeWayMatchResult {
  const tol = input.tolerance ?? DEFAULT_MATCH_TOLERANCE;
  const reasons: string[] = [];
  const openToInvoiceQty6 = input.receivedQty6 - input.invoicedQty6;

  if (input.thisInvoicedQty6 <= 0n) {
    reasons.push('invoiced quantity must be positive');
  }

  // Quantity: bill only what is received and not yet invoiced (+ tolerance).
  if (input.thisInvoicedQty6 > openToInvoiceQty6 + tol.qtyAbs6) {
    reasons.push(
      `invoiced qty ${formatScaled6(input.thisInvoicedQty6)} exceeds received-not-invoiced ` +
        `${formatScaled6(openToInvoiceQty6 < 0n ? 0n : openToInvoiceQty6)} ` +
        `(qty tolerance ${formatScaled6(tol.qtyAbs6)})`,
    );
  }

  // Price: within an absolute OR relative tolerance of the PO price.
  const priceDiff = absBig(input.thisInvoiceUnitPrice6 - input.poUnitPrice6);
  const relAllowed = (absBig(input.poUnitPrice6) * tol.pricePctBp) / 10000n;
  const allowed = relAllowed > tol.priceAbs6 ? relAllowed : tol.priceAbs6;
  if (priceDiff > allowed) {
    reasons.push(
      `invoice unit price ${formatScaled6(input.thisInvoiceUnitPrice6)} deviates from PO price ` +
        `${formatScaled6(input.poUnitPrice6)} beyond tolerance (allowed ±${formatScaled6(allowed)})`,
    );
  }

  return { ok: reasons.length === 0, reasons, openToInvoiceQty6 };
}
