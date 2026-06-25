import { paginationQuerySchema, shipmentStatusSchema, transportModeSchema } from '@erp/shared';
import { z } from 'zod';

/** Shipment request DTOs (Zod). A non-posting physical document — mirrors the export-declaration DTO shape. */

/** YYYY-MM-DD calendar date (mirrors the declaration DTOs' isoDate). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

export const shipmentItemSchema = z.object({
  /** The delivery (출고전표) this line carries — the service resolves it read-only (company-checked via its SO). */
  deliveryId: z.string().uuid(),
});

export const createShipmentSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** 운송모드 — SEA/AIR/RAIL/TRUCK (shared enum); v1 use is SEA/AIR. */
  transportMode: transportModeSchema,
  /** 선사/항공사 (carrier), optional. */
  carrier: z.string().min(1).max(128).optional(),
  /** 항차/편명, optional. */
  vesselFlightNo: z.string().min(1).max(64).optional(),
  /** 운송서류번호 (B/L·AWB), optional at create — usually stamped on book(). */
  transportDocNo: z.string().min(1).max(35).optional(),
  /** 출발항, optional. */
  portOfLoading: z.string().min(1).max(64).optional(),
  /** 도착항, optional. */
  portOfDischarge: z.string().min(1).max(64).optional(),
  /** 예정 출항일, optional. */
  etd: isoDate.optional(),
  /** 예정 도착일, optional. */
  eta: isoDate.optional(),
  headerText: z.string().min(1).max(256).optional(),
  items: z.array(shipmentItemSchema).min(1).max(200),
});
export type CreateShipmentDto = z.infer<typeof createShipmentSchema>;

/**
 * book(): PLANNED → BOOKED, optionally stamping the carrier / 운송서류번호 / 항차·편명 / ETD·ETA firmed up at
 * booking. All optional — a bare book() just flips the status.
 */
export const bookShipmentSchema = z.object({
  transportDocNo: z.string().min(1).max(35).optional(),
  vesselFlightNo: z.string().min(1).max(64).optional(),
  carrier: z.string().min(1).max(128).optional(),
  etd: isoDate.optional(),
  eta: isoDate.optional(),
});
export type BookShipmentDto = z.infer<typeof bookShipmentSchema>;

export const shipmentQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  status: shipmentStatusSchema.optional(),
  transportMode: transportModeSchema.optional(),
});
export type ShipmentQuery = z.infer<typeof shipmentQuerySchema>;
