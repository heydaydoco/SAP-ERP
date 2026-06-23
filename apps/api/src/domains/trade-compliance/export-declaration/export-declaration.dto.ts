import {
  currencyCodeSchema,
  exportDeclarationStatusSchema,
  incotermSchema,
  paginationQuerySchema,
  tradeDirectionSchema,
} from '@erp/shared';
import { z } from 'zod';

/** Export-declaration request DTOs (Zod). A non-posting customs document — mirrors the sales-order DTO. */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

/** Positive quantity / weight, NUMERIC(18,6) shape. */
const qtySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, 'qty must be a non-negative decimal, max 6 decimals')
  .refine((v) => Number(v) > 0, 'qty must be positive');

/** Non-negative FOB amount, NUMERIC(18,4) shape (per-currency minor units enforced by Money at posting). */
const fobSchema = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'fobAmount must be a non-negative decimal, NUMERIC(18,4)');

/** ISO-3166-1 alpha-2 country code. */
const countrySchema = z.string().regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO code');

/** HS classification code (관세 품목분류) — digits only, 6–10 long (matches material_trade's DB CHECK). */
const hsCodeSchema = z.string().regex(/^[0-9]{6,10}$/, 'hs code must be 6–10 digits');

export const exportDeclarationItemSchema = z.object({
  materialId: z.string().uuid(),
  /** HS code snapshot for this line; omit to inherit `material_trade.hs_code`. */
  hsCode: hsCodeSchema.optional(),
  /** Country of origin (원산지); omit to inherit `material_trade.country_of_origin`. */
  originCountry: countrySchema.optional(),
  qty: qtySchema,
  uom: z.string().min(1).max(8),
  fobAmount: fobSchema,
  /** Net weight (순중량), optional. */
  netWeight: qtySchema.optional(),
});

export const createExportDeclarationSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** The foreign buyer / consignee (must carry a customer role). */
  customerBpId: z.string().uuid(),
  /** The customs broker (관세사), optional. */
  brokerBpId: z.string().uuid().optional(),
  /**
   * The SD delivery (출고전표) being exported — the physical lineage anchor. The service resolves it
   * read-only to its 601 GI and writes a `DECLARES` doc_flow edge onto that goods movement (출고 없이
   * 수출 없음, so the delivery always exists at 신고 time). REQUIRED.
   */
  sourceDeliveryId: z.string().uuid(),
  declarationDate: isoDate,
  /** 수출신고번호 (UNI-PASS MRN) — optional at filing; usually stamped on accept(). Captured as a string. */
  declarationNo: z.string().min(1).max(35).optional(),
  /** Trade hooks (§12) — Zod-validated (shared enums), stored as additive nullable columns, no DB CHECK. */
  incoterm: incotermSchema.optional(),
  /** EXP / DOM / IMP — STORED ONLY; defaults to EXP. A non-EXP value only raises a SOFT warning. */
  tradeDirection: tradeDirectionSchema.optional(),
  shipToCountry: countrySchema.optional(),
  customsOffice: z.string().min(1).max(16).optional(),
  /** Declaration value currency (export invoice currency; may be foreign). */
  currency: currencyCodeSchema,
  headerText: z.string().min(1).max(256).optional(),
  items: z.array(exportDeclarationItemSchema).min(1).max(200),
});
export type CreateExportDeclarationDto = z.infer<typeof createExportDeclarationSchema>;

/** accept(): stamp the externally-issued 수출신고번호 (MRN) and flip SUBMITTED → ACCEPTED. */
export const acceptExportDeclarationSchema = z.object({
  declarationNo: z.string().min(1).max(35),
});
export type AcceptExportDeclarationDto = z.infer<typeof acceptExportDeclarationSchema>;

export const exportDeclarationQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  customerBpId: z.string().uuid().optional(),
  status: exportDeclarationStatusSchema.optional(),
  declarationNo: z.string().min(1).max(35).optional(),
});
export type ExportDeclarationQuery = z.infer<typeof exportDeclarationQuerySchema>;
