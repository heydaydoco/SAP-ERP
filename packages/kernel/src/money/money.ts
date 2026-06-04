import type { CurrencyCode } from '@erp/shared';
import { ISO_4217, MONEY_DB_SCALE, type CurrencyRegistry } from './currency';

/**
 * Currency-aware Money value object (root CLAUDE.md §3.1).
 *
 * Holds an **exact integer amount in the currency's minor units** (e.g. cents for USD, whole won
 * for KRW, fils for BHD) — no floating point, ever. Arithmetic requires matching currencies.
 * Persisted as a fixed-scale `NUMERIC(18,4)` string regardless of the currency's own exponent.
 */

const DECIMAL_RE = /^-?\d{1,14}(\.\d{1,6})?$/;
const NUMERIC_RE = /^-?\d{1,14}(\.\d{1,4})?$/;

function pow10(n: number): bigint {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
}

/** Format a signed integer (scaled by `scale` decimal places) as a decimal string. */
function formatScaled(value: bigint, scale: number): string {
  const neg = value < 0n;
  const abs = (neg ? -value : value).toString().padStart(scale + 1, '0');
  const cut = abs.length - scale;
  const intPart = abs.slice(0, cut);
  const frac = scale > 0 ? `.${abs.slice(cut)}` : '';
  return `${neg ? '-' : ''}${intPart}${frac}`;
}

export class Money {
  private constructor(
    /** Exact amount in the currency's minor units. */
    readonly minorUnits: bigint,
    readonly currency: string,
    /** Minor-unit exponent (decimal places) for this currency. */
    readonly minorUnit: number,
  ) {}

  /** Build from a raw minor-unit integer (e.g. cents). */
  static fromMinorUnits(
    minorUnits: bigint,
    currency: CurrencyCode,
    registry: CurrencyRegistry = ISO_4217,
  ): Money {
    const { code, minorUnit } = registry.get(currency);
    return new Money(minorUnits, code, minorUnit);
  }

  /** Zero in the given currency. */
  static zero(currency: CurrencyCode, registry: CurrencyRegistry = ISO_4217): Money {
    return Money.fromMinorUnits(0n, currency, registry);
  }

  /** Build from a decimal string/number. Rejects more fraction digits than the currency allows. */
  static of(
    amount: string | number,
    currency: CurrencyCode,
    registry: CurrencyRegistry = ISO_4217,
  ): Money {
    const { code, minorUnit } = registry.get(currency);
    const str = typeof amount === 'number' ? String(amount) : amount.trim();
    if (!DECIMAL_RE.test(str)) {
      throw new Error(`invalid money amount: "${str}"`);
    }
    const neg = str.startsWith('-');
    const [intPart = '0', fracPart = ''] = str.replace('-', '').split('.');
    if (fracPart.length > minorUnit) {
      throw new Error(`"${str}" has more decimals than ${code} allows (${minorUnit})`);
    }
    const frac = fracPart.padEnd(minorUnit, '0');
    const minor = BigInt(intPart) * pow10(minorUnit) + (frac ? BigInt(frac) : 0n);
    return new Money(neg ? -minor : minor, code, minorUnit);
  }

  /** Parse a `NUMERIC(18,4)` DB value back into Money. Strict: rejects sub-minor-unit residue. */
  static fromNumeric(
    value: string,
    currency: CurrencyCode,
    registry: CurrencyRegistry = ISO_4217,
  ): Money {
    const { code, minorUnit } = registry.get(currency);
    const str = value.trim();
    if (!NUMERIC_RE.test(str)) {
      throw new Error(`invalid NUMERIC(18,4) value: "${str}"`);
    }
    const neg = str.startsWith('-');
    const [intPart = '0', fracPart = ''] = str.replace('-', '').split('.');
    const frac4 = fracPart.padEnd(MONEY_DB_SCALE, '0');
    const scaled = BigInt(intPart) * pow10(MONEY_DB_SCALE) + BigInt(frac4);
    const divisor = pow10(MONEY_DB_SCALE - minorUnit);
    if (scaled % divisor !== 0n) {
      throw new Error(`"${str}" has finer precision than ${code} allows (${minorUnit} decimals)`);
    }
    const minor = scaled / divisor;
    return new Money(neg ? -minor : minor, code, minorUnit);
  }

  /** New Money in the same currency from a minor-unit integer (no registry lookup). */
  withMinorUnits(minorUnits: bigint): Money {
    return new Money(minorUnits, this.currency, this.minorUnit);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new Error(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.withMinorUnits(this.minorUnits + other.minorUnits);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return this.withMinorUnits(this.minorUnits - other.minorUnits);
  }

  /**
   * This amount times `percent`% — e.g. 10% output VAT of USD 1.99 → 0.20 (19.9¢ rounds to 20¢).
   * Rounded **half away from zero** to the currency's minor unit. Tax codes and the pricing engine
   * both call this so rate rounding lives in one place, never per-domain. `percent` is a decimal
   * string/number in percentage points ('10', '10.5'); more than 6 fraction digits is rejected.
   */
  percentage(percent: string | number): Money {
    const str = typeof percent === 'number' ? String(percent) : percent.trim();
    if (!DECIMAL_RE.test(str)) throw new Error(`invalid percentage: "${str}"`);
    const neg = str.startsWith('-');
    const [intPart = '0', fracPart = ''] = str.replace('-', '').split('.');
    const numerator = BigInt(intPart + fracPart) * (neg ? -1n : 1n);
    const denominator = 100n * pow10(fracPart.length);
    return this.multiplyRounded(numerator, denominator);
  }

  /** this.minorUnits * num / den, rounded half away from zero. `den` must be positive. */
  private multiplyRounded(num: bigint, den: bigint): Money {
    const negative = this.minorUnits < 0n !== num < 0n;
    const abs = (x: bigint): bigint => (x < 0n ? -x : x);
    const scaled = abs(this.minorUnits) * abs(num);
    // floor((2*scaled + den) / (2*den)) rounds the magnitude half-up.
    const rounded = (scaled * 2n + den) / (den * 2n);
    return this.withMinorUnits(negative ? -rounded : rounded);
  }

  negate(): Money {
    return this.withMinorUnits(-this.minorUnits);
  }

  abs(): Money {
    return this.minorUnits < 0n ? this.negate() : this;
  }

  get sign(): -1 | 0 | 1 {
    return this.minorUnits < 0n ? -1 : this.minorUnits > 0n ? 1 : 0;
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  equals(other: Money): boolean {
    return other.currency === this.currency && other.minorUnits === this.minorUnits;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits ? -1 : this.minorUnits > other.minorUnits ? 1 : 0;
  }

  /** Decimal string at the currency's natural scale, e.g. USD `"1.50"`, KRW `"1500"`. */
  toDecimal(): string {
    return formatScaled(this.minorUnits, this.minorUnit);
  }

  /** Decimal string at the DB scale `NUMERIC(18,4)`, e.g. USD `"1.5000"`, KRW `"1500.0000"`. */
  toNumeric(): string {
    const scaled = this.minorUnits * pow10(MONEY_DB_SCALE - this.minorUnit);
    return formatScaled(scaled, MONEY_DB_SCALE);
  }

  toString(): string {
    return `${this.toDecimal()} ${this.currency}`;
  }

  /** Wire shape: pairs the NUMERIC string with its currency (matches @erp/shared amountSchema). */
  toJSON(): { amount: string; currency: string } {
    return { amount: this.toNumeric(), currency: this.currency };
  }
}
