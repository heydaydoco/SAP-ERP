import { z } from 'zod';

/**
 * Export-declaration (수출신고) lifecycle — shared by trade-compliance api + (later) web.
 * `SUBMITTED` = filed with 관세청 (UNI-PASS); `ACCEPTED` = 수리, when the 수출신고필증 / MRN
 * (수출신고번호) is issued; `REJECTED` = 반려, a UNI-PASS 전송 the 관세청 refuses (terminal — no MRN, no
 * 수리일; 재전송/정정 is a later slice). A 수출신고 is a COMPLIANCE document — it posts NOTHING to FI: a
 * Korean export is 영세율 (no output VAT, no export duty), so value already moved at SD billing. The
 * declaration only LINKS (via doc_flow `DECLARES`) into the zero-rated billing it is the 첨부서류
 * evidence for. Validated by Zod here; enforced on the document table by a status CHECK.
 */
export const EXPORT_DECLARATION_STATUS = ['SUBMITTED', 'ACCEPTED', 'REJECTED'] as const;
export const exportDeclarationStatusSchema = z.enum(EXPORT_DECLARATION_STATUS);
export type ExportDeclarationStatus = z.infer<typeof exportDeclarationStatusSchema>;

/**
 * Import-declaration (수입신고) lifecycle — the symmetric IMPORT leg. `SUBMITTED` = filed with 관세청
 * (UNI-PASS); `ACCEPTED` = 수리, when the 수입신고필증 / MRN (수입신고번호) + 신고수리일 are stamped;
 * `REJECTED` = 반려, a UNI-PASS 전송 the 관세청 refuses (terminal — no MRN, no 수리일; 재전송/정정 is a later
 * slice). A 수입신고 is a COMPLIANCE document — it posts NOTHING to FI: import accounting (관세 + 수입부가세
 * 재고원가 배부) is the landed-cost document's sole job, so the declaration's 과세가격/관세액/부가세액 are legal
 * RECORD fields. It only LINKS (via doc_flow `DECLARES`) onto the same 수입 GR. Validated by Zod here;
 * enforced on the document table by a status CHECK.
 */
export const IMPORT_DECLARATION_STATUS = ['SUBMITTED', 'ACCEPTED', 'REJECTED'] as const;
export const importDeclarationStatusSchema = z.enum(IMPORT_DECLARATION_STATUS);
export type ImportDeclarationStatus = z.infer<typeof importDeclarationStatusSchema>;

/**
 * Duty-drawback claim (관세환급 신청) lifecycle — 간이정액환급 (simplified fixed-rate refund of the customs
 * duty paid on imported inputs that were re-exported). `CLAIMED` = the refund claim is filed against one or
 * more 수출신고 (non-posting); `APPROVED` = 관세청 결정 → the FIRST real FI journal in trade-compliance posts
 * (Dr 관세환급금 미수금 / Cr 관세환급수익); `PAID` = 관세청 입금 → the MIRROR journal (Dr 보통예금 / Cr 관세환급금
 * 미수금) closes the receivable. Validated by Zod here; enforced on the document table by a status CHECK.
 * (개별환급 — BOM/소요량 전개 — is a later slice; this is 간이정액 only.)
 */
export const DRAWBACK_CLAIM_STATUS = ['CLAIMED', 'APPROVED', 'PAID'] as const;
export const drawbackClaimStatusSchema = z.enum(DRAWBACK_CLAIM_STATUS);
export type DrawbackClaimStatus = z.infer<typeof drawbackClaimStatusSchema>;

/**
 * UNI-PASS connector (관세청 전자통관) enums — the EDI transmission layer over the two customs declarations.
 * Shared so the DB CHECKs on `unipass_message`, the submit DTO, and the TS types stay consistent (the same
 * single-source-of-truth pattern as the declaration status enums above).
 */

/** Which declaration a transmission targets — the polymorphic reference's discriminator. */
export const DECLARATION_TYPE = ['EXPORT', 'IMPORT'] as const;
export const declarationTypeSchema = z.enum(DECLARATION_TYPE);
export type DeclarationType = z.infer<typeof declarationTypeSchema>;

/** Transmission direction: OUTBOUND (관세청으로 송신) | INBOUND (관세청 수신). v1 writes OUTBOUND only. */
export const UNIPASS_DIRECTION = ['OUTBOUND', 'INBOUND'] as const;
export const unipassDirectionSchema = z.enum(UNIPASS_DIRECTION);
export type UnipassDirection = z.infer<typeof unipassDirectionSchema>;

/** Transmission result: ACCEPTED (수리, MRN 부여) | REJECTED (반려, 터미널). */
export const UNIPASS_RESULT = ['ACCEPTED', 'REJECTED'] as const;
export const unipassResultSchema = z.enum(UNIPASS_RESULT);
export type UnipassResult = z.infer<typeof unipassResultSchema>;

/**
 * Stub message classification: DECLARATION (신고 송신) | RESPONSE (응답 수신). The precise 관세청 EDI message
 * code is the deferred interface boundary; v1 writes DECLARATION (the synchronous stub folds the response
 * into the same OUTBOUND row).
 */
export const UNIPASS_MESSAGE_TYPE = ['DECLARATION', 'RESPONSE'] as const;
export const unipassMessageTypeSchema = z.enum(UNIPASS_MESSAGE_TYPE);
export type UnipassMessageType = z.infer<typeof unipassMessageTypeSchema>;
