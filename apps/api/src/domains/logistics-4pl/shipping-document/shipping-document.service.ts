import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import {
  DOC_FLOW_TYPE_SHIPMENT,
  DOC_FLOW_TYPE_SHIPPING_DOCUMENT,
  DOC_TYPE_SHIPPING_DOC,
  NUMBER_OBJECT_SHIPPING_DOC,
  REL_DOCUMENTS,
} from '../logistics-4pl.constants.js';
import type {
  AddShippingDocumentDto,
  CreateShippingDocumentSetDto,
  ShippingDocumentSetQuery,
} from './shipping-document.dto.js';

/**
 * Shipping-document service (logistics-4pl.shipping-document = 선적 서류세트). Bundles the physical trade
 * documents (B/L·CI·PL) issued for one shipment into one OPEN set + N document lines (kind / number / 발행일 /
 * 발행처). **Posts NOTHING to FI** — exactly like the customs declaration / shipment, a 서류세트 is a physical
 * record that moves no value (the invoice amount was already accounted at SD billing; the set only registers
 * document numbers). No JournalService, no account-determination, no `posting_key`, no idempotency gate
 * (create is a visible document, a retry is a visible duplicate). Its only linkage is a doc_flow `DOCUMENTS`
 * edge onto the shipment.
 *
 * A set opens with zero-or-more lines and stays OPEN (완결/COMPLETED is a later slice); `addDocument` appends
 * one line at a time, since the B/L usually issues after the CI/PL (after 부킹). The (doc_kind, doc_number)
 * pair is unique within a set — registering the same document twice is a mistake.
 *
 * Cross-domain reads are READ-ONLY (the shipment, for existence + company check) — never a write into another
 * domain's tables.
 */
@Injectable()
export class ShippingDocumentService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
  ) {}

  async create(dto: CreateShippingDocumentSetDto, actor = 'system') {
    await this.getCompany(dto.companyCodeId);

    // Shipment (READ-ONLY): must exist and belong to this company. Lineage is the doc_flow DOCUMENTS edge
    // written below — there is no cross-domain FK (the graph is generic, like freight_settlement.shipment_id).
    await this.resolveShipment(dto.shipmentId, dto.companyCodeId);

    // Reject a repeated (docKind, docNumber) inside the request payload (the DB unique also enforces it; this
    // pre-check returns a clean 400 instead of a constraint error). Mirrors shipment.create's deliveryId guard.
    this.assertNoDuplicateDocuments(dto.items);

    return this.db.transaction(async (tx) => {
      const docNo = await this.numbering.next(NUMBER_OBJECT_SHIPPING_DOC, 'GLOBAL', tx);
      const [header] = await tx
        .insert(schema.shippingDocumentSet)
        .values({
          docType: DOC_TYPE_SHIPPING_DOC,
          docNo,
          status: 'OPEN',
          companyCodeId: dto.companyCodeId,
          shipmentId: dto.shipmentId,
          reference: dto.reference ?? null,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning({ id: schema.shippingDocumentSet.id });
      if (!header) throw new Error('shipping_document_set insert returned no row');

      if (dto.items.length > 0) {
        await tx.insert(schema.shippingDocumentItem).values(
          dto.items.map((it, i) => ({
            setId: header.id,
            lineNo: i + 1,
            docKind: it.docKind,
            docNumber: it.docNumber,
            issueDate: it.issueDate ?? null,
            issuerText: it.issuerText ?? null,
            createdBy: actor,
            updatedBy: actor,
          })),
        );
      }

      // Physical lineage (§4.3): the set DOCUMENTS the shipment. PLAIN string target (the doc_flow graph is
      // generic) — never a journal (the set posts nothing).
      await this.docFlow.link(
        {
          sourceType: DOC_FLOW_TYPE_SHIPPING_DOCUMENT,
          sourceId: header.id,
          targetType: DOC_FLOW_TYPE_SHIPMENT,
          targetId: dto.shipmentId,
          relType: REL_DOCUMENTS,
        },
        tx,
      );

      return { shippingDocumentSetId: header.id, docNo, status: 'OPEN' as const };
    });
  }

  /** Append ONE document line to an existing set, at the next line number. */
  async addDocument(setId: string, dto: AddShippingDocumentDto, actor = 'system') {
    const [set] = await this.db
      .select({ id: schema.shippingDocumentSet.id })
      .from(schema.shippingDocumentSet)
      .where(eq(schema.shippingDocumentSet.id, setId));
    if (!set) throw new NotFoundException(`shipping document set ${setId} not found`);

    // Next line number = current max + 1. A set holds at most a few dozen lines, so rather than a heavy lock
    // we compute-then-insert optimistically: the (set_id, doc_kind, doc_number) unique owns the real
    // business-duplicate guard (→ 409), while the (set_id, line_no) unique catches a rare concurrent-append
    // race — on which we recompute the next line_no and retry (bounded), never surfacing it as a 500.
    for (let attempt = 0; ; attempt += 1) {
      const [maxRow] = await this.db
        .select({ max: sql<number>`coalesce(max(${schema.shippingDocumentItem.lineNo}), 0)::int` })
        .from(schema.shippingDocumentItem)
        .where(eq(schema.shippingDocumentItem.setId, setId));
      const nextLineNo = (maxRow?.max ?? 0) + 1;

      try {
        const [line] = await this.db
          .insert(schema.shippingDocumentItem)
          .values({
            setId,
            lineNo: nextLineNo,
            docKind: dto.docKind,
            docNumber: dto.docNumber,
            issueDate: dto.issueDate ?? null,
            issuerText: dto.issuerText ?? null,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning();
        return line;
      } catch (e) {
        // The same (docKind, docNumber) already in this set → 409 (registering the same document twice).
        if (isUniqueViolation(e, 'shipping_document_item_kind_number_uq')) {
          throw new ConflictException(
            `document ${dto.docKind} ${dto.docNumber} is already registered in this set`,
          );
        }
        // Lost the line_no race to a concurrent append → recompute the next line_no and retry (bounded).
        if (isUniqueViolation(e, 'shipping_document_item_no_uq') && attempt < 3) continue;
        throw e;
      }
    }
  }

  /** Header + items (line order) + outward lineage edges (DOCUMENTS), or 404. */
  async getShippingDocumentSet(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.shippingDocumentSet)
      .where(eq(schema.shippingDocumentSet.id, id));
    if (!header) throw new NotFoundException(`shipping document set ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.shippingDocumentItem)
      .where(eq(schema.shippingDocumentItem.setId, id))
      .orderBy(asc(schema.shippingDocumentItem.lineNo));
    const lineage = await this.docFlow.forward(DOC_FLOW_TYPE_SHIPPING_DOCUMENT, id);
    return { ...header, items, lineage };
  }

  /** A shipment's shipping document sets (drill-down), in doc order. */
  async listForShipment(shipmentId: string) {
    return this.db
      .select()
      .from(schema.shippingDocumentSet)
      .where(eq(schema.shippingDocumentSet.shipmentId, shipmentId))
      .orderBy(asc(schema.shippingDocumentSet.docNo));
  }

  async listShippingDocumentSets(q: ShippingDocumentSetQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.shippingDocumentSet)
      .where(this.listWhere(q))
      .orderBy(desc(schema.shippingDocumentSet.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countShippingDocumentSets(q: ShippingDocumentSetQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.shippingDocumentSet)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: ShippingDocumentSetQuery) {
    return and(
      q.companyCodeId ? eq(schema.shippingDocumentSet.companyCodeId, q.companyCodeId) : undefined,
      q.shipmentId ? eq(schema.shippingDocumentSet.shipmentId, q.shipmentId) : undefined,
    );
  }

  private async getCompany(companyCodeId: string) {
    const [company] = await this.db
      .select()
      .from(schema.companyCode)
      .where(eq(schema.companyCode.id, companyCodeId));
    if (!company) throw new NotFoundException(`company code ${companyCodeId} not found`);
    return company;
  }

  /**
   * Resolve the shipment (READ-ONLY): it must exist and belong to `companyCodeId` (a wrong-company shipment
   * → 400, an unknown one → 404). Mirrors the freight-settlement shipment guard.
   */
  private async resolveShipment(shipmentId: string, companyCodeId: string) {
    const [ship] = await this.db
      .select({
        id: schema.shipment.id,
        docNo: schema.shipment.docNo,
        companyCodeId: schema.shipment.companyCodeId,
      })
      .from(schema.shipment)
      .where(eq(schema.shipment.id, shipmentId));
    if (!ship) throw new NotFoundException(`shipment ${shipmentId} not found`);
    if (ship.companyCodeId !== companyCodeId) {
      throw new BadRequestException(`shipment ${ship.docNo} belongs to another company code`);
    }
    return ship;
  }

  /** Reject a repeated (docKind, docNumber) inside one create payload (the DB unique also enforces it). */
  private assertNoDuplicateDocuments(items: CreateShippingDocumentSetDto['items']) {
    const seen = new Set<string>();
    for (const it of items) {
      const key = `${it.docKind}:${it.docNumber}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          `a document may appear at most once in a set (duplicate ${it.docKind} ${it.docNumber})`,
        );
      }
      seen.add(key);
    }
  }
}

/** True iff `e` is the Postgres unique violation for the named constraint. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint_name?: unknown };
  return err.code === '23505' && err.constraint_name === constraint;
}
