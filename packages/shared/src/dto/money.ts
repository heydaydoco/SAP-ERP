import { z } from 'zod';

/**
 * Wire/DTO representation of money: a **decimal string** at the DB scale `NUMERIC(18,4)` — never a
 * JS number (floats corrupt money). Always paired with a currency code (ISO 4217). Computation uses
 * the currency-aware `Money` value object in `@erp/kernel`; this schema is only the transport shape.
 */
export const moneySchema = z
  .string()
  .regex(/^-?\d{1,14}(\.\d{1,4})?$/, 'money must be a decimal string, NUMERIC(18,4)');
export type MoneyString = z.infer<typeof moneySchema>;

/** ISO 4217 currency code (3 upper-case letters). */
export const currencyCodeSchema = z.string().length(3).regex(/^[A-Z]{3}$/);
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/** An amount + its currency. */
export const amountSchema = z.object({
  amount: moneySchema,
  currency: currencyCodeSchema,
});
export type Amount = z.infer<typeof amountSchema>;

/**
 * Foreign-exchange rate: a positive decimal string at the fx_rate master scale `NUMERIC(18,6)`
 * (units of the target currency per 1 unit of the source). Used for the optional manual-GL FX-rate
 * override; the kernel `Money.convert` enforces the same scale-6 cap when it translates.
 */
export const fxRateSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'fx rate must be a positive decimal, NUMERIC(18,6)')
  .refine((v) => Number(v) > 0, 'fx rate must be greater than zero');
export type FxRateString = z.infer<typeof fxRateSchema>;
