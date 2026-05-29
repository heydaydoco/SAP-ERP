import { z } from 'zod';

/**
 * Money is `NUMERIC(18,2)` in the DB and a **decimal string** in transit/code — never a JS number
 * (floats corrupt money). Pair every money value with a currency code (ISO 4217).
 */
export const moneySchema = z
  .string()
  .regex(/^-?\d{1,16}(\.\d{1,2})?$/, 'money must be a decimal string with up to 2 fraction digits');
export type Money = z.infer<typeof moneySchema>;

/** ISO 4217 currency code (3 upper-case letters). */
export const currencyCodeSchema = z.string().length(3).regex(/^[A-Z]{3}$/);
export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/** An amount + its currency. */
export const amountSchema = z.object({
  amount: moneySchema,
  currency: currencyCodeSchema,
});
export type Amount = z.infer<typeof amountSchema>;
