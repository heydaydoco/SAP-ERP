import { check, index, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns, pk } from '../_shared/columns';

/**
 * UNI-PASS transmission log (trade-compliance.unipass = 관세청 전자통관 connector) — the EDI send/receive
 * history for a customs declaration. NOT a §4.2 document (no doc_no / posting_key / numbering): it is a
 * transmission LOG, so it carries `auditColumns()` only — the same audit-4-only judgment as
 * `drawback_simplified_rate`, but this is a log, not config.
 *
 * One row per transmission, **1:N onto a declaration** (a declaration may be transmitted more than once — the
 * schema is built for it, though v1 only transmits a still-SUBMITTED declaration, so a re-send after 수리/반려
 * is refused by the service). The reference is **POLYMORPHIC**: `declaration_type` (EXPORT|IMPORT) +
 * `declaration_id` — a PLAIN uuid, NO cross-subject FK (the same generic convention as 수입신고's
 * `source_goods_movement_id`); the service resolves it against the right declaration table.
 *
 * ⚠️ This is an EXTERNAL-INTEGRATION (EDI) log, **NOT an accounting document — it NEVER posts to FI.** The
 * actual 관세청 EDI message format (EDIFACT/XML/관세청 API 규격), authentication, and async polling/callbacks are
 * all DEFERRED (interface boundary); v1 is a synchronous STUB. `message_type` is the minimal stub
 * classification (DECLARATION 송신 / RESPONSE 수신) — the precise EDI message code is intentionally unfilled.
 */
export const unipassMessage = pgTable(
  'unipass_message',
  {
    id: pk(),
    /** Which declaration kind this transmission is for — EXPORT (수출신고) or IMPORT (수입신고). */
    declarationType: varchar('declaration_type', { length: 16 }).notNull(),
    /**
     * The declaration's id (`export_declaration.id` or `import_declaration.id`, per `declaration_type`) — a
     * PLAIN uuid, NO cross-subject FK (the polymorphic reference is resolved by the service, like 수입신고's
     * source refs). Indexed with `declaration_type` for the per-declaration history lookup.
     */
    declarationId: uuid('declaration_id').notNull(),
    /** Transmission direction: OUTBOUND (관세청으로 송신) | INBOUND (관세청 수신). v1 writes OUTBOUND only. */
    direction: varchar('direction', { length: 8 }).notNull(),
    /**
     * Stub message classification: DECLARATION (신고 송신) | RESPONSE (응답 수신). The precise 관세청 EDI message
     * code is the deferred interface boundary; v1 writes DECLARATION (the synchronous stub folds the response
     * into the same OUTBOUND row).
     */
    messageType: varchar('message_type', { length: 16 }).notNull(),
    /**
     * 전송 결과: ACCEPTED (수리) | REJECTED (반려). NULL = 송신 직후 응답 전 (provisioned for a future async flow;
     * the v1 synchronous stub always sets it on the OUTBOUND row).
     */
    result: varchar('result', { length: 16 }),
    /** MRN issued on 수리 — the SAME value stamped onto the declaration's `declaration_no`. NULL on 반려. */
    mrn: varchar('mrn', { length: 35 }),
    /** 응답/반려 사유 텍스트 (free-form). */
    responseMessage: varchar('response_message', { length: 512 }),
    /** Transmission timestamp. */
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    ...auditColumns(),
  },
  (t) => [
    check('unipass_message_declaration_type_ck', sql`${t.declarationType} in ('EXPORT', 'IMPORT')`),
    check('unipass_message_direction_ck', sql`${t.direction} in ('OUTBOUND', 'INBOUND')`),
    check('unipass_message_message_type_ck', sql`${t.messageType} in ('DECLARATION', 'RESPONSE')`),
    check(
      'unipass_message_result_ck',
      sql`${t.result} is null or ${t.result} in ('ACCEPTED', 'REJECTED')`,
    ),
    index('unipass_message_declaration_idx').on(t.declarationType, t.declarationId),
  ],
);
