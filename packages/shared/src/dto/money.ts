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
