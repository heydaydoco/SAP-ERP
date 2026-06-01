/**
 * Currency metadata for the money value object (root CLAUDE.md §3.1).
 *
 * The authoritative currency master lives in Phase 1 (master-data.currency); until then the kernel
 * ships a default ISO-4217 minor-unit table. The Phase 1 master implements `CurrencyRegistry` from
 * the DB and is injected wherever exact exponents matter — the engine never assumes "2 decimals."
 */

/** Money is persisted as NUMERIC(MONEY_DB_PRECISION, MONEY_DB_SCALE) for every currency. */
export const MONEY_DB_PRECISION = 18;
/** Largest minor-unit exponent we persist for; DB money column is NUMERIC(18, MONEY_DB_SCALE). */
export const MONEY_DB_SCALE = 4;

export interface CurrencyMeta {
  readonly code: string;
  /** ISO-4217 minor-unit exponent = number of decimal places. KRW/JPY=0, USD=2, BHD=3. */
  readonly minorUnit: number;
}

export interface CurrencyRegistry {
  get(code: string): CurrencyMeta;
  has(code: string): boolean;
}

/** Common ISO-4217 minor units. Anything not here must be registered (we never default to 2). */
const ISO_4217_MINOR_UNITS: Readonly<Record<string, number>> = {
  // 0-decimal
  KRW: 0,
  JPY: 0,
  VND: 0,
  CLP: 0,
  // 2-decimal
  USD: 2,
  EUR: 2,
  CNY: 2,
  GBP: 2,
  HKD: 2,
  SGD: 2,
  AUD: 2,
  CAD: 2,
  CHF: 2,
  THB: 2,
  // 3-decimal
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
};

export class StaticCurrencyRegistry implements CurrencyRegistry {
  private readonly table: Map<string, number>;

  constructor(table: Readonly<Record<string, number>> = ISO_4217_MINOR_UNITS) {
    this.table = new Map(Object.entries(table));
    for (const [code, mu] of this.table) {
      if (mu < 0 || mu > MONEY_DB_SCALE) {
        throw new Error(`currency ${code}: minorUnit ${mu} outside 0..${MONEY_DB_SCALE}`);
      }
    }
  }

  has(code: string): boolean {
    return this.table.has(code);
  }

  get(code: string): CurrencyMeta {
    const minorUnit = this.table.get(code);
    if (minorUnit === undefined) {
      throw new Error(`unknown currency "${code}" — register it in the currency master`);
    }
    return { code, minorUnit };
  }

  /** Add/override a currency (used by the Phase 1 currency master to feed DB-driven exponents). */
  register(code: string, minorUnit: number): void {
    if (minorUnit < 0 || minorUnit > MONEY_DB_SCALE) {
      throw new Error(`currency ${code}: minorUnit ${minorUnit} outside 0..${MONEY_DB_SCALE}`);
    }
    this.table.set(code, minorUnit);
  }
}

/** Default registry (ISO-4217 common set). Phase 1's currency master can supply its own instance. */
export const ISO_4217: CurrencyRegistry = new StaticCurrencyRegistry();
