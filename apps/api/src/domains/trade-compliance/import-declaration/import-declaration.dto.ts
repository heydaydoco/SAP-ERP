import {
  currencyCodeSchema,
  importDeclarationStatusSchema,
  incotermSchema,
  paginationQuerySchema,
  tradeDirectionSchema,
} from '@erp/shared';
import { z } from 'zod';

/** Import-declaration request DTOs (Zod). A non-posting customs document — mirrors export-declaration. */

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

/** Non-negative amount, NUMERIC(18,4) shape (per-currency minor units enforced by Money in the service). */
const amountSchema = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount must be a non-negative decimal, NUMERIC(18,4)');

/** 관세율 (%) — non-negative, NUMERIC(7,4) shape (≤999.9999). */
const dutyRateSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'duty rate must be a non-negative percent, max 4 decimals');

/** ISO-3166-1 alpha-2 country code. */
const countrySchema = z.string().regex(/^[A-Z]{2}$/, 'country must be a 2-letter ISO code');

/** HS classification code (관세 품목분류) — digits only, 6–10 long (matches material_trade's DB CHECK). */
const hsCodeSchema = z.string().regex(/^[0-9]{6,10}$/, 'hs code must be 6–10 digits');

export const importDeclarationItemSchema = z.object({
  materialId: z.string().uuid(),
  /** Source GR line (`goods_movement_item.id`) this declared line maps to; optional (validated to belong to the GR). */
  sourceGrItemRef: z.string().uuid().optional(),
  /** HS code snapshot for this line; omit to inherit `material_trade.hs_code`. */
  hsCode: hsCodeSchema.optional(),
  /** Country of origin (원산지); omit to inherit `material_trade.country_of_origin`. */
  originCountry: countrySchema.optional(),
  qty: qtySchema,
  uom: z.string().min(1).max(8),
  /** Line 과세가격 (CIF customs value). */
  customsValue: amountSchema,
  /** 관세율 (%) — optional; enables the G3b duty-sanity check only when present on EVERY line. */
  dutyRate: dutyRateSchema.optional(),
});

export const createImportDeclarationSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** The overseas supplier / consignor (must carry a vendor role). */
  supplierBpId: z.string().uuid(),
  /** The customs broker (관세사), optional. */
  brokerBpId: z.string().uuid().optional(),
  /**
   * The 수입 GR (101 goods_movement) being declared — the physical lineage anchor. The service resolves it
   * read-only (must be a 101 GR of this company) and writes a `DECLARES` doc_flow edge onto it (the same
   * node landed cost capitalizes against). REQUIRED.
   */
  sourceGoodsMovementId: z.string().uuid(),
  declarationDate: isoDate,
  /** 수입신고번호 (UNI-PASS MRN) — optional at filing; usually stamped on accept(). Captured as a string. */
  declarationNo: z.string().min(1).max(35).optional(),
  /** Trade hooks (§12) — Zod-validated (shared enums), stored as additive nullable columns, no DB CHECK. */
  incoterm: incotermSchema.optional(),
  /** EXP / DOM / IMP — STORED ONLY; defaults to IMP. A non-IMP value only raises a SOFT warning. */
  tradeDirection: tradeDirectionSchema.optional(),
  /** Predominant 원산지 header hook (per-line origin is on each item). */
  originCountry: countrySchema.optional(),
  customsOffice: z.string().min(1).max(16).optional(),
  /** Declaration value currency (import invoice currency; may be foreign). */
  currency: currencyCodeSchema,
  /** 과세가격 (CIF) — the declared header total; the line sum is consistency-checked against it (G3a). */
  customsValue: amountSchema,
  /** 관세액 — declaration RECORD field; posts nothing (landed cost owns the accounting). */
  dutyAmount: amountSchema,
  /** 수입부가세액 — declaration RECORD field; posts nothing. */
  importVatAmount: amountSchema,
  headerText: z.string().min(1).max(256).optional(),
  items: z.array(importDeclarationItemSchema).min(1).max(200),
});
export type CreateImportDeclarationDto = z.infer<typeof createImportDeclarationSchema>;

/** accept(): stamp the externally-issued 수입신고번호 (MRN) + 신고수리일 and flip SUBMITTED → ACCEPTED. */
export const acceptImportDeclarationSchema = z.object({
  declarationNo: z.string().min(1).max(35),
  /** 신고수리일 — optional; recorded when the 수리 is captured. */
  acceptanceDate: isoDate.optional(),
});
export type AcceptImportDeclarationDto = z.infer<typeof acceptImportDeclarationSchema>;

export const importDeclarationQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  supplierBpId: z.string().uuid().optional(),
  status: importDeclarationStatusSchema.optional(),
  declarationNo: z.string().min(1).max(35).optional(),
});
export type ImportDeclarationQuery = z.infer<typeof importDeclarationQuerySchema>;
