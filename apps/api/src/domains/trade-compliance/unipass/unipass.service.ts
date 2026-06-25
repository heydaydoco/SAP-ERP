import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { declarationTypeSchema, type DeclarationType } from '@erp/shared';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { stubMrn } from './unipass-stub.js';
import type { SubmitDeclarationDto } from './unipass.dto.js';

/**
 * UNI-PASS connector service (trade-compliance.unipass = 관세청 전자통관) — the EDI transmission layer over the
 * two customs declarations (수출신고 / 수입신고). It "transmits" a SUBMITTED declaration to 관세청 and records the
 * 수리(ACCEPTED)/반려(REJECTED) verdict, owning a 1:N transmission log per declaration. **This is a synchronous
 * STUB**: the real 관세청 EDI message format, authentication, and async polling/callbacks are DEFERRED (interface
 * boundary); the caller SIMULATES the verdict via `SubmitDeclarationDto.result`.
 *
 * ⚠️ **It NEVER posts to FI** — this is an external-integration slice, not an accounting one (no JournalService,
 * no account-determination, no posting_key). The declaration documents keep status OWNERSHIP; unipass only
 * TRANSITIONS their status (the same atomic SUBMITTED-guard that accept() uses, replicated inside the unipass
 * transaction so the declaration flip + the log insert are one all-or-nothing unit). accept() is left untouched
 * (the manual back-door stamp path); this is the formal connector path layered on top, one-directional
 * (unipass → declarations, never the reverse).
 */
@Injectable()
export class UnipassService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Transmit a SUBMITTED declaration to UNI-PASS (stub) and record the verdict.
   *   ACCEPTED (수리) → atomic SUBMITTED→ACCEPTED flip + declaration_no = MRN + acceptance_date stamp.
   *   REJECTED (반려) → atomic SUBMITTED→REJECTED flip (terminal; NO MRN, NO 수리일).
   * Idempotency/concurrency: only a still-SUBMITTED declaration transmits (a re-send of an ACCEPTED/REJECTED
   * declaration 409s); two concurrent transmissions race on the atomic guard (the loser flips zero rows → 409).
   */
  async submit(
    declarationType: string,
    declarationId: string,
    dto: SubmitDeclarationDto,
    actor = 'system',
  ) {
    const type = this.parseType(declarationType);
    const decl = await this.loadDeclaration(type, declarationId);
    if (decl.status !== 'SUBMITTED') {
      throw new ConflictException(
        `${type.toLowerCase()} declaration ${declarationId} is ${decl.status}; only a SUBMITTED declaration can be transmitted to UNI-PASS`,
      );
    }

    // ── UNI-PASS transmission STUB (interface boundary) ──────────────────────────────────────────────
    // The real connector serializes the declaration into the 관세청 EDI message, transmits it over the
    // authenticated channel, and parses the 수리/반려 response. v1 simulates the verdict from the DTO.
    const result = dto.result ?? 'ACCEPTED';
    const sentDate = new Date().toISOString().slice(0, 10);

    return this.db.transaction(async (tx) => {
      let mrn: string | null = null;
      if (result === 'ACCEPTED') {
        // 수리: stamp the (provided or stub) MRN + 신고수리일, exactly as accept() does — but inside this tx.
        mrn = dto.mrn ?? stubMrn(type, declarationId);
        const flipped = await this.flip(tx, type, declarationId, {
          status: 'ACCEPTED',
          declarationNo: mrn,
          acceptanceDate: dto.acceptanceDate ?? sentDate,
          actor,
        });
        if (!flipped) {
          throw new ConflictException(
            `${type.toLowerCase()} declaration ${declarationId} is no longer SUBMITTED — concurrent transmission`,
          );
        }
      } else {
        // 반려: terminal, no MRN / no 수리일.
        const flipped = await this.flip(tx, type, declarationId, { status: 'REJECTED', actor });
        if (!flipped) {
          throw new ConflictException(
            `${type.toLowerCase()} declaration ${declarationId} is no longer SUBMITTED — concurrent transmission`,
          );
        }
      }

      const [message] = await tx
        .insert(schema.unipassMessage)
        .values({
          declarationType: type,
          declarationId,
          direction: 'OUTBOUND',
          messageType: 'DECLARATION',
          result,
          mrn,
          responseMessage: dto.responseMessage ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning({ id: schema.unipassMessage.id, sentAt: schema.unipassMessage.sentAt });
      if (!message) throw new Error('unipass_message insert returned no row');

      return {
        declarationType: type,
        declarationId,
        status: result, // the declaration's resulting status (ACCEPTED 수리 / REJECTED 반려)
        result,
        mrn,
        messageId: message.id,
        sentAt: message.sentAt,
      };
    });
  }

  /** The declaration's transmission log (시간순), or 404 if the declaration does not exist. */
  async getMessages(declarationType: string, declarationId: string) {
    const type = this.parseType(declarationType);
    await this.loadDeclaration(type, declarationId);
    return this.db
      .select()
      .from(schema.unipassMessage)
      .where(
        and(
          eq(schema.unipassMessage.declarationType, type),
          eq(schema.unipassMessage.declarationId, declarationId),
        ),
      )
      .orderBy(asc(schema.unipassMessage.sentAt), asc(schema.unipassMessage.id));
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private parseType(declarationType: string): DeclarationType {
    const parsed = declarationTypeSchema.safeParse(declarationType);
    if (!parsed.success) {
      throw new BadRequestException(
        `declarationType must be EXPORT or IMPORT (got '${declarationType}')`,
      );
    }
    return parsed.data;
  }

  /** Read-only existence check on the right declaration table; returns its status (404 if missing). */
  private async loadDeclaration(type: DeclarationType, id: string): Promise<{ status: string }> {
    if (type === 'EXPORT') {
      const [row] = await this.db
        .select({ status: schema.exportDeclaration.status })
        .from(schema.exportDeclaration)
        .where(eq(schema.exportDeclaration.id, id));
      if (!row) throw new NotFoundException(`export declaration ${id} not found`);
      return row;
    }
    const [row] = await this.db
      .select({ status: schema.importDeclaration.status })
      .from(schema.importDeclaration)
      .where(eq(schema.importDeclaration.id, id));
    if (!row) throw new NotFoundException(`import declaration ${id} not found`);
    return row;
  }

  /**
   * Atomic transition guard, replicating accept()'s pattern inside the unipass tx: only a still-SUBMITTED row
   * flips (a concurrent transmission's loser updates zero rows → caller 409s). Returns whether a row flipped.
   * `declarationNo` / `acceptanceDate` are set only when supplied (수리); a 반려 omits them.
   */
  private async flip(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    type: DeclarationType,
    id: string,
    patch: { status: string; declarationNo?: string; acceptanceDate?: string; actor: string },
  ): Promise<boolean> {
    const set = {
      status: patch.status,
      ...(patch.declarationNo !== undefined ? { declarationNo: patch.declarationNo } : {}),
      ...(patch.acceptanceDate !== undefined ? { acceptanceDate: patch.acceptanceDate } : {}),
      updatedBy: patch.actor,
      updatedAt: new Date(),
    };
    if (type === 'EXPORT') {
      const [row] = await tx
        .update(schema.exportDeclaration)
        .set(set)
        .where(
          and(
            eq(schema.exportDeclaration.id, id),
            eq(schema.exportDeclaration.status, 'SUBMITTED'),
          ),
        )
        .returning({ id: schema.exportDeclaration.id });
      return Boolean(row);
    }
    const [row] = await tx
      .update(schema.importDeclaration)
      .set(set)
      .where(
        and(eq(schema.importDeclaration.id, id), eq(schema.importDeclaration.status, 'SUBMITTED')),
      )
      .returning({ id: schema.importDeclaration.id });
    return Boolean(row);
  }
}
