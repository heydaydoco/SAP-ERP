import { unipassResultSchema } from '@erp/shared';
import { z } from 'zod';

/**
 * UNI-PASS submit DTO (Zod). The connector is a synchronous STUB, so the caller SIMULATES the 관세청 verdict:
 * `result` (default ACCEPTED, applied in the service so a direct service call gets it too — the controller's
 * ZodValidationPipe does not), an optional `mrn` to stamp on 수리 (else a deterministic stub MRN is generated),
 * an optional 수리일, and an optional response/반려 사유. There is NO companyCodeId — submit acts on a
 * declaration by id and trusts the declaration's own company (the same by-id convention as accept()/approve()).
 */

/** YYYY-MM-DD calendar date (mirrors the declaration DTOs' isoDate). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'date must be a real calendar date');

export const submitDeclarationSchema = z.object({
  /** Simulated 관세청 verdict — defaults to ACCEPTED (수리) in the service when omitted. */
  result: unipassResultSchema.optional(),
  /** MRN to stamp on 수리; omit to let the stub generate a deterministic one. Ignored on 반려. */
  mrn: z.string().min(1).max(35).optional(),
  /** 신고수리일 to stamp on 수리; omit to default to the transmission date. Ignored on 반려. */
  acceptanceDate: isoDate.optional(),
  /** 응답 / 반려 사유 text, recorded on the transmission log row. */
  responseMessage: z.string().min(1).max(512).optional(),
});
export type SubmitDeclarationDto = z.infer<typeof submitDeclarationSchema>;
