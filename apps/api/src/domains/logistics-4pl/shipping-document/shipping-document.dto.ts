import { paginationQuerySchema, shippingDocKindSchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Shipping-document request DTOs (Zod). A NON-POSTING physical document — a set of trade shipping documents
 * (B/L·CI·PL) bundled against ONE shipment. v1 records document HEADER metadata only (kind / number / 발행일 /
 * 발행처), no money / FX / currency (the set moves no value). Mirrors the export-declaration / shipment DTO shape.
 */

/** YYYY-MM-DD calendar date (mirrors the export-declaration / shipment DTOs' isoDate). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

export const shippingDocumentItemSchema = z.object({
  /** B/L (선하증권/AWB) · CI (상업송장) · PL (포장명세서). */
  docKind: shippingDocKindSchema,
  /** The document's own number (B/L no., invoice no., packing-list no.). */
  docNumber: z.string().min(1).max(64),
  /** 발행일 — optional (a document may be registered before it is issued). */
  issueDate: isoDate.optional(),
  /** 발행처 — free text (carrier / shipper / forwarder), optional. */
  issuerText: z.string().min(1).max(128).optional(),
});
export type ShippingDocumentItemDto = z.infer<typeof shippingDocumentItemSchema>;

export const createShippingDocumentSetSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** The shipment (선적) this set documents — the service resolves it read-only (must be the same company). */
  shipmentId: z.string().uuid(),
  reference: z.string().min(1).max(128).optional(),
  headerText: z.string().min(1).max(256).optional(),
  /** Initial documents — may be EMPTY (a set opens before its B/L is issued; addDocument appends later). */
  items: z.array(shippingDocumentItemSchema).min(0).max(50),
});
export type CreateShippingDocumentSetDto = z.infer<typeof createShippingDocumentSetSchema>;

/** addDocument(): append ONE document line to an existing set. */
export const addShippingDocumentSchema = shippingDocumentItemSchema;
export type AddShippingDocumentDto = z.infer<typeof addShippingDocumentSchema>;

export const shippingDocumentSetQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  shipmentId: z.string().uuid().optional(),
});
export type ShippingDocumentSetQuery = z.infer<typeof shippingDocumentSetQuerySchema>;
