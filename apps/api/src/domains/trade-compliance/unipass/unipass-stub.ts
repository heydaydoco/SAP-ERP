import type { DeclarationType } from '@erp/shared';

/**
 * UNI-PASS connector STUB boundary (관세청 전자통관). The real connector serializes the declaration into the
 * 관세청 EDI message (EDIFACT/XML/관세청 API 규격), transmits it over the authenticated 사전계약 channel, and
 * parses the 수리/반려 response — ALL of that is DEFERRED (an explicit interface boundary). v1 is a synchronous
 * stub: the caller simulates the 관세청 verdict (`SubmitDeclarationDto.result`), and the only computed value is
 * the placeholder MRN below. This file holds the one piece of pure, unit-testable logic in the slice.
 */

/**
 * Synthesize a DETERMINISTIC placeholder MRN (수출/수입신고번호) for a 수리(ACCEPTED) transmission.
 *
 * A real MRN is issued by 관세청 UNI-PASS on 수리 and parsed from the EDI response; here we derive it from the
 * declaration id so the same declaration always yields the same MRN — no clock, no randomness, so it is exactly
 * reproducible in tests and idempotent. The real connector replaces this with the parsed MRN (interface
 * boundary). Type-prefixed (ED/IM) and well under the `declaration_no` / `mrn` 35-char column limit.
 */
export function stubMrn(declarationType: DeclarationType, declarationId: string): string {
  const prefix = declarationType === 'EXPORT' ? 'ED' : 'IM';
  const hex = declarationId.replace(/-/g, '').slice(0, 16).toUpperCase();
  return `STUB-${prefix}-${hex}`;
}
