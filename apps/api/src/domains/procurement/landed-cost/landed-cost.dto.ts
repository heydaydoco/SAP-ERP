import { z } from 'zod';

/**
 * Landed-cost request DTO (Zod). ONE incidental-cost invoice (freight / duty / insurance / clearance
 * — or a 관세사 settlement bundling them) from ONE forwarder/관세사, capitalized onto the received
 * lines of ONE import PO by received value, plus the customs-paid import VAT (수입부가세).
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

/** NUMERIC(18,4) money string, non-negative. */
const amount = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount must be a non-negative decimal, max 4 decimals');

export const createLandedCostSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** The import PO whose received stock this cost capitalizes onto. */
  purchaseOrderId: z.string().uuid(),
  /** The forwarder / 관세사 the AP open item is raised against (must carry a vendor role). */
  vendorBpId: z.string().uuid(),
  /** Forwarder/관세사 invoice or 세금계산서 number. */
  reference: z.string().min(1).max(128),
  /** 수입신고번호 — the customs declaration the import VAT belongs to (세관 is the VAT counterparty). */
  importDeclarationNo: z.string().min(1).max(64).optional(),
  postingDate: isoDate,
  documentDate: isoDate,
  /** Cost-invoice (document) currency — the functional currency, or a foreign one. */
  currency: z.string().length(3).toUpperCase(),
  /** Total incidental cost being capitalized, in the document currency; must be positive. */
  costAmount: amount.refine((v) => Number(v) > 0, 'costAmount must be positive'),
  /**
   * Customs-paid import VAT (수입부가세) in the FUNCTIONAL currency (KRW), supplied directly from the
   * 수입세금계산서 (base = CIF + 관세). NOT capitalized. Only valid on a functional-currency document
   * (a foreign forwarder freight invoice carries no customs VAT). Defaults to 0.
   */
  importVatAmount: amount.optional(),
  /** INPUT import-VAT tax code (→ 부가세대급금 1350); required when importVatAmount > 0. */
  vatTaxCode: z.string().min(1).max(16).optional(),
  headerText: z.string().min(1).max(256).optional(),
  /** Client idempotency key (§5.2); minted when absent. Capped at 120 (column 128) for the lc: key. */
  postingKey: z.string().min(1).max(120).optional(),
});
export type CreateLandedCostDto = z.infer<typeof createLandedCostSchema>;
