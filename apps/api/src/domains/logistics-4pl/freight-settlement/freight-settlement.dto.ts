import { fxRateSchema, paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Freight-settlement request DTOs (Zod). ONE forwarder freight invoice (ocean freight + THC + 내륙 summed
 * in v1) against ONE shipment, raising an AP open item on the forwarder's vendor role. No VAT in v1 (a
 * foreign forwarder's export freight is 국외제공용역/영세율 — no deductible import VAT). Mirrors the
 * landed-cost / shipment DTO shapes.
 */

/** YYYY-MM-DD calendar date (mirrors the landed-cost / shipment DTOs' isoDate). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

/** NUMERIC(18,4) money string, non-negative (mirrors landed-cost's amount). */
const amount = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount must be a non-negative decimal, max 4 decimals');

export const createFreightSettlementSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** The shipment (선적) this freight settles — the service resolves it read-only (must be the same company). */
  shipmentId: z.string().uuid(),
  /** The forwarder the AP open item is raised against (must carry a vendor role; recon substituted from it). */
  forwarderBpId: z.string().uuid(),
  /** Freight-invoice (document) currency — the functional currency, or a foreign one. */
  currency: z.string().length(3).toUpperCase(),
  /** Total freight being settled, in the document currency; must be positive. */
  freightAmount: amount.refine((v) => Number(v) > 0, 'freightAmount must be positive'),
  postingDate: isoDate,
  documentDate: isoDate,
  /**
   * Optional document→functional FX-rate override (units of functional per 1 unit of `currency`, scale ≤ 6).
   * FX-only: ignored on a functional-currency invoice; when omitted, the 'M' master rate on `documentDate`
   * is resolved. Passed straight to `JournalService.post` — the freight service does no FX math itself.
   */
  fxRate: fxRateSchema.optional(),
  /** Forwarder invoice / B/L reference number (optional in v1). */
  reference: z.string().min(1).max(128).optional(),
  headerText: z.string().min(1).max(256).optional(),
  /** Client idempotency key (§5.2); minted when absent. Capped at 120 (column 128) so `<key>:je` fits. */
  postingKey: z.string().min(1).max(120).optional(),
});
export type CreateFreightSettlementDto = z.infer<typeof createFreightSettlementSchema>;

export const freightSettlementQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  shipmentId: z.string().uuid().optional(),
});
export type FreightSettlementQuery = z.infer<typeof freightSettlementQuerySchema>;
