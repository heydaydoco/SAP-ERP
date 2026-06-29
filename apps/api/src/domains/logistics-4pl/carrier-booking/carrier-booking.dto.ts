import { paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Carrier-booking request DTOs (Zod). A NON-POSTING reservation placed with a carrier (선사) for ONE shipment:
 * the carrier's booking number + cut-off deadlines. No money/FX/currency (freight is the separate
 * freight_settlement). Mirrors the shipping-document DTO shape; cut-offs use the tracking-event datetime style.
 */

export const createCarrierBookingSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** The shipment (선적) this booking is for — resolved read-only (must be the same company). */
  shipmentId: z.string().uuid(),
  /** The carrier (선사/항공사) the booking is placed with — must carry a `carrier` BP role (resolved read-only). */
  carrierBpId: z.string().uuid(),
  /** The booking number the carrier issued. */
  bookingNo: z.string().min(1).max(64),
  /** 반입마감 (CY cut-off) — ISO 8601 with offset/Z. Optional: the carrier may not have confirmed it yet. */
  cargoCutoff: z.string().datetime({ offset: true }).optional(),
  /** 서류마감 (Shipping Instruction deadline) — ISO 8601, optional. */
  docCutoff: z.string().datetime({ offset: true }).optional(),
  /** VGM 마감 (SOLAS) — ISO 8601, optional. */
  vgmCutoff: z.string().datetime({ offset: true }).optional(),
  reference: z.string().min(1).max(128).optional(),
  headerText: z.string().min(1).max(256).optional(),
});
export type CreateCarrierBookingDto = z.infer<typeof createCarrierBookingSchema>;

export const carrierBookingQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  shipmentId: z.string().uuid().optional(),
  carrierBpId: z.string().uuid().optional(),
});
export type CarrierBookingQuery = z.infer<typeof carrierBookingQuerySchema>;
