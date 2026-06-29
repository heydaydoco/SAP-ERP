import { paginationQuerySchema, trackingEventTypeSchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Tracking-event request DTOs (Zod). An append-only observation log against ONE shipment — NON-POSTING (no
 * money/FX/currency) and INDEPENDENT of the shipment status machine. Mirrors the shipping-document DTO shape.
 */

export const createTrackingEventSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** The shipment (선적) this event is observed against — resolved read-only (must be the same company). */
  shipmentId: z.string().uuid(),
  /** Observed milestone — SEPARATE from the shipment status machine (never drives the lifecycle). */
  eventType: trackingEventTypeSchema,
  /** Observation timestamp — ISO 8601 with offset/Z (the moment the event occurred, NOT server now()). */
  eventTime: z.string().datetime({ offset: true }),
  /** 발생 장소 (port/terminal/city — UN/LOCODE or name), optional. */
  location: z.string().min(1).max(128).optional(),
  /** Free description, optional. */
  description: z.string().min(1).max(256).optional(),
});
export type CreateTrackingEventDto = z.infer<typeof createTrackingEventSchema>;

export const trackingEventQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  shipmentId: z.string().uuid().optional(),
  eventType: trackingEventTypeSchema.optional(),
});
export type TrackingEventQuery = z.infer<typeof trackingEventQuerySchema>;
