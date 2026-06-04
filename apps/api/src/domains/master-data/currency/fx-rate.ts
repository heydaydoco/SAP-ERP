/**
 * Pure FX-rate resolution (root CLAUDE.md §5.4 — FX translation is a mandatory unit-tested calc).
 * Kept free of the DB so it is tested directly; the service fetches candidate rows and delegates here.
 */

/** The fields rate resolution needs from an `fx_rate` row. */
export interface FxRateCandidate {
  /** Effective-from date, YYYY-MM-DD (lexicographic order == chronological for ISO dates). */
  validFrom: string;
  rate: string;
}

/**
 * Pick the rate effective on `onDate`: the candidate with the latest `validFrom` on/before it.
 * Candidates need not be pre-sorted. Returns `null` when no rate is yet effective.
 */
export function resolveFxRate<T extends FxRateCandidate>(
  candidates: T[],
  onDate: string,
): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (candidate.validFrom <= onDate && (best === null || candidate.validFrom > best.validFrom)) {
      best = candidate;
    }
  }
  return best;
}
