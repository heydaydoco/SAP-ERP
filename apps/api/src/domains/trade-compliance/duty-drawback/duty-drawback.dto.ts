import { drawbackClaimStatusSchema, paginationQuerySchema } from '@erp/shared';
import { z } from 'zod';

/**
 * Duty-drawback (관세환급, 간이정액) request DTOs (Zod). The claim bundles one or more source 수출신고 lines;
 * FOB / HS / 수리일 are READ (snapshotted) from the linked export_declaration, never re-keyed — the only
 * per-line input is the OPTIONAL manual 원화 FOB override (`fobKrw`, the 수출신고필증 원화 FOB; auto FX is the
 * default path). approve() takes the 관세청 결정 환급액 (defaults to the claimed total).
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

/** Non-negative amount, NUMERIC(18,4) shape (per-currency minor units enforced by Money in the service). */
const amountSchema = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/, 'amount must be a non-negative decimal, NUMERIC(18,4)');

export const drawbackClaimItemSchema = z.object({
  /** The source 수출신고 (export_declaration.id) this refund line draws from. */
  sourceExportDeclarationId: z.string().uuid(),
  /** The source 수출신고 line (export_declaration_item.id) — validated to belong to the declaration. */
  sourceExportDeclarationItemRef: z.string().uuid(),
  /**
   * OPTIONAL manual 원화 FOB override (the 수출신고필증 stated 원화 FOB). When present it takes precedence and
   * fx_rate is NULL (manual wins); when omitted, FOB is auto-converted to KRW at the source 수리일 'M' rate.
   * KRW precision is enforced by Money in the service (whole won — a decimal is a 400).
   */
  fobKrw: amountSchema.optional(),
});

export const createDrawbackClaimSchema = z.object({
  companyCodeId: z.string().uuid(),
  /** 환급신청일. */
  claimDate: isoDate,
  headerText: z.string().min(1).max(256).optional(),
  items: z.array(drawbackClaimItemSchema).min(1).max(200),
});
export type CreateDrawbackClaimDto = z.infer<typeof createDrawbackClaimSchema>;

/** approve(): 관세청 결정 → post the FI journal. `approvedTotal` defaults to the claimed total (KRW). */
export const approveDrawbackClaimSchema = z.object({
  /** 환급결정일 (관세청 결정). */
  approvalDate: isoDate,
  /** 관세청 결정 환급액 (KRW); omit to use the claimed total. May differ (결정액 우선). */
  approvedTotal: amountSchema.optional(),
});
export type ApproveDrawbackClaimDto = z.infer<typeof approveDrawbackClaimSchema>;

/**
 * receipt(): 관세청 입금 → post the MIRROR journal (Dr 보통예금 / Cr 관세환급금 미수금) closing the receivable.
 * v1 is FULL receipt only — `receivedAmount` is optional and, when supplied, MUST equal the approved total
 * (a mismatch is a 400; omit it to settle the approved total in full).
 */
export const receiptDrawbackClaimSchema = z.object({
  /** 환급금 입금일 (관세청 실제 입금일). */
  receiptDate: isoDate,
  /** 입금액 (KRW); omit to settle the approved total in full. When present it must equal the approved total. */
  receivedAmount: amountSchema.optional(),
});
export type ReceiptDrawbackClaimDto = z.infer<typeof receiptDrawbackClaimSchema>;

export const drawbackClaimQuerySchema = paginationQuerySchema.extend({
  companyCodeId: z.string().uuid().optional(),
  status: drawbackClaimStatusSchema.optional(),
});
export type DrawbackClaimQuery = z.infer<typeof drawbackClaimQuerySchema>;
