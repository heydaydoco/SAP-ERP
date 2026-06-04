import { char, date, integer, numeric, pgTable, unique, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';

/**
 * Currency master (master-data.currency) — the authoritative source of each currency's minor-unit
 * exponent (root CLAUDE.md §3.1). The kernel `Money` value object's `CurrencyRegistry` is fed from
 * here (`DbCurrencyRegistry`) so exact decimal places are never hard-coded as "2 cents". `code` is
 * the ISO-4217 natural key that other tables (fx_rate, gl_account, …) reference.
 */
export const currency = pgTable('currency', {
  id: pk(),
  /** ISO-4217 alphabetic code, e.g. 'KRW'. */
  code: char('code', { length: 3 }).notNull().unique(),
  name: varchar('name', { length: 64 }).notNull(),
  /** Minor-unit exponent = decimal places (KRW/JPY=0, USD/EUR/CNY=2, BHD/KWD=3); kept within 0..4. */
  minorUnit: integer('minor_unit').notNull(),
  symbol: varchar('symbol', { length: 8 }),
  ...auditColumns(),
});

/**
 * Foreign-exchange rate (master-data.fx_rate). Translates `fromCurrency` into `toCurrency`, effective
 * from `validFrom`; resolution picks the latest `validFrom` on/before the posting date. `rateType`
 * separates spot vs monthly-average etc. ('M' = average, the default for FI translation).
 */
export const fxRate = pgTable(
  'fx_rate',
  {
    id: pk(),
    fromCurrency: char('from_currency', { length: 3 }).notNull(),
    toCurrency: char('to_currency', { length: 3 }).notNull(),
    rateType: varchar('rate_type', { length: 4 }).notNull().default('M'),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    /** Units of toCurrency per 1 unit of fromCurrency. Higher scale than money (§3.1 allows rates). */
    rate: numeric('rate', { precision: 18, scale: 6 }).notNull(),
    ...auditColumns(),
  },
  (t) => [unique('fx_rate_uq').on(t.fromCurrency, t.toCurrency, t.rateType, t.validFrom)],
);
