import { z } from 'zod';

/**
 * Export-declaration (수출신고) lifecycle — shared by trade-compliance api + (later) web.
 * `SUBMITTED` = filed with 관세청 (UNI-PASS); `ACCEPTED` = 수리, when the 수출신고필증 / MRN
 * (수출신고번호) is issued. A 수출신고 is a COMPLIANCE document — it posts NOTHING to FI: a Korean
 * export is 영세율 (no output VAT, no export duty), so value already moved at SD billing. The
 * declaration only LINKS (via doc_flow `DECLARES`) into the zero-rated billing it is the 첨부서류
 * evidence for. Validated by Zod here; enforced on the document table by a status CHECK.
 */
export const EXPORT_DECLARATION_STATUS = ['SUBMITTED', 'ACCEPTED'] as const;
export const exportDeclarationStatusSchema = z.enum(EXPORT_DECLARATION_STATUS);
export type ExportDeclarationStatus = z.infer<typeof exportDeclarationStatusSchema>;
