import { currencyCodeSchema, moneySchema } from '@erp/shared';
import { z } from 'zod';

/** AR (customer) invoice request DTOs (Zod). The customer is referenced by BP UUID (no public
 *  getBpByCode); the AR reconciliation account is substituted from its customer role, never sent. */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

export const arInvoiceLineSchema = z.object({
  /** Revenue GL account this line credits (D: the account comes from the document, not VKOA). */
  revenueAccount: z.string().min(1).max(16),
  /** Positive exclusive/net amount (VAT is computed on top), NUMERIC(18,4). */
  netAmount: moneySchema.refine((v) => Number(v) > 0, 'net amount must be positive'),
  /** OUTPUT VAT code; omit for a non-taxable line. */
  taxCode: z.string().min(1).max(16).optional(),
  costCenterId: z.string().uuid().optional(),
  lineText: z.string().min(1).max(256).optional(),
});

export const createArInvoiceSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** Customer business-partner id (must carry a customer role). */
  partnerId: z.string().uuid(),
  postingDate: isoDate,
  /**
   * Invoice (business-event) date — SAP BLDAT — **required**: it drives the derived due date, so an
   * invoice must carry its real date rather than silently inherit the posting date.
   */
  documentDate: isoDate,
  currency: currencyCodeSchema,
  /** Source reference, e.g. the customer invoice / 세금계산서 number. */
  reference: z.string().min(1).max(128),
  headerText: z.string().min(1).max(256).optional(),
  /**
   * Client idempotency key (§5.2); minted when absent. Capped at 120 so `<key>:REV` fits 128. A
   * replay MUST carry the identical invoice — reusing a key with different lines returns the FIRST
   * posting's journal (and the response totals echo THIS request, not the stored entry). Use the
   * invoice number so the key is deterministic per document.
   */
  postingKey: z.string().min(1).max(120).optional(),
  lines: z.array(arInvoiceLineSchema).min(1).max(100),
});
export type CreateArInvoiceDto = z.infer<typeof createArInvoiceSchema>;

export const arOpenItemQuerySchema = z.object({
  companyCodeId: z.string().uuid(),
  partnerId: z.string().uuid(),
});
export type ArOpenItemQuery = z.infer<typeof arOpenItemQuerySchema>;
