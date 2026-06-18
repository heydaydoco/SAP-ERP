import { currencyCodeSchema, incotermSchema, paginationQuerySchema, tradeDirectionSchema } from '@erp/shared';
import { z } from 'zod';

/** Sales-order request DTOs (Zod). Mirror of the purchase-order DTO on the O2C side. */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

/** Positive quantity, NUMERIC(18,6) shape. */
const qtySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'qty must be a non-negative decimal, max 6 decimals')
  .refine((v) => Number(v) > 0, 'qty must be positive');

/** Non-negative SALES unit price, NUMERIC(18,6) shape (a rate — may be finer than the currency). */
const unitPriceSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'unitPrice must be a non-negative decimal, max 6 decimals');

/** ISO-3166-1 alpha-2 country code. */
const countrySchema = z.string().regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO code');

export const salesOrderItemSchema = z.object({
  materialId: z.string().uuid(),
  /** Issuing plant; its material valuation (accounting view) must exist for the GI. */
  plantId: z.string().uuid(),
  storageLocationId: z.string().uuid(),
  orderedQty: qtySchema,
  /** Agreed SALES unit price (P-A — taken directly from the DTO; pricing-condition reuse is deferred). */
  unitPrice: unitPriceSchema,
  /** OUTPUT VAT code billing applies to this line (§5 — explicit; omit for a non-taxable line). */
  taxCode: z.string().min(1).max(16).optional(),
});

export const createSalesOrderSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** Customer business-partner id (must carry a customer role). */
  customerBpId: z.string().uuid(),
  salesOrgId: z.string().uuid().optional(),
  currency: currencyCodeSchema,
  orderDate: isoDate,
  /** Trade hooks (§12) — Zod-validated (shared enums), stored as additive nullable columns, no DB CHECK. */
  incoterm: incotermSchema.optional(),
  /** EXP / DOM / IMP — STORED ONLY; never determines the VAT rate (the line tax_code does). */
  tradeDirection: tradeDirectionSchema.optional(),
  shipToCountry: countrySchema.optional(),
  /** 수출신고번호 / 내국신용장(구매확인서) 번호 backing a zero-rated sale. */
  zeroRateDocNo: z.string().min(1).max(35).optional(),
  headerText: z.string().min(1).max(256).optional(),
  items: z.array(salesOrderItemSchema).min(1).max(200),
});
export type CreateSalesOrderDto = z.infer<typeof createSalesOrderSchema>;

export const salesOrderQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  customerBpId: z.string().uuid().optional(),
});
export type SalesOrderQuery = z.infer<typeof salesOrderQuerySchema>;
