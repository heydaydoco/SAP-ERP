import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import {
  DOC_FLOW_TYPE_DELIVERY,
  DOC_FLOW_TYPE_SHIPMENT,
  DOC_TYPE_SHIPMENT,
  NUMBER_OBJECT_SHIPMENT,
  REL_CONTAINS,
} from '../logistics-4pl.constants.js';
import { nextShipmentStatus } from './shipment-status.js';
import type { BookShipmentDto, CreateShipmentDto, ShipmentQuery } from './shipment.dto.js';

/**
 * Shipment service (logistics-4pl.shipment = 선적) — the backbone document of the 4PL logistics domain. Bundles
 * one or more deliveries (출고전표) into one physical transport unit and tracks its forward-only lifecycle
 * (PLANNED → BOOKED → DEPARTED → ARRIVED). **Posts NOTHING to FI** — a shipment is a physical document; freight
 * accounting attaches with a later logistics_charge slice. The only linkage is a doc_flow `CONTAINS` edge per
 * delivery (the multi-edge loop of landed-cost CAPITALIZES / drawback REFUNDS).
 *
 * Cross-domain reads are READ-ONLY (delivery / sales_order for the physical anchor + company check) — never a
 * write into another domain's tables/services. No JournalService, no account-determination (non-posting).
 */
@Injectable()
export class ShipmentService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
  ) {}

  async create(dto: CreateShipmentDto, actor = 'system') {
    await this.getCompany(dto.companyCodeId);

    const deliveryIds = dto.items.map((it) => it.deliveryId);
    if (new Set(deliveryIds).size !== deliveryIds.length) {
      throw new BadRequestException(
        'a delivery may appear at most once in a shipment (duplicate deliveryId)',
      );
    }

    // Resolve every delivery (read-only): each must exist and belong to this company (a delivery carries no
    // company column, so the check rides its SO — the export-declaration resolveDelivery pattern, batched).
    await this.resolveDeliveries(deliveryIds, dto.companyCodeId);

    return this.db.transaction(async (tx) => {
      const docNo = await this.numbering.next(NUMBER_OBJECT_SHIPMENT, 'GLOBAL', tx);
      const [header] = await tx
        .insert(schema.shipment)
        .values({
          docType: DOC_TYPE_SHIPMENT,
          docNo,
          status: 'PLANNED',
          companyCodeId: dto.companyCodeId,
          transportMode: dto.transportMode,
          carrier: dto.carrier ?? null,
          vesselFlightNo: dto.vesselFlightNo ?? null,
          transportDocNo: dto.transportDocNo ?? null,
          portOfLoading: dto.portOfLoading ?? null,
          portOfDischarge: dto.portOfDischarge ?? null,
          etd: dto.etd ?? null,
          eta: dto.eta ?? null,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning({ id: schema.shipment.id });
      if (!header) throw new Error('shipment insert returned no row');

      await tx.insert(schema.shipmentItem).values(
        dto.items.map((it, i) => ({
          shipmentId: header.id,
          lineNo: i + 1,
          deliveryId: it.deliveryId,
          createdBy: actor,
          updatedBy: actor,
        })),
      );

      // Physical lineage (§4.3): the shipment CONTAINS each delivery it carries. PLAIN string target (the
      // doc_flow graph is generic) — never a journal (the shipment posts nothing). deliveryIds are distinct.
      for (const deliveryId of deliveryIds) {
        await this.docFlow.link(
          {
            sourceType: DOC_FLOW_TYPE_SHIPMENT,
            sourceId: header.id,
            targetType: DOC_FLOW_TYPE_DELIVERY,
            targetId: deliveryId,
            relType: REL_CONTAINS,
          },
          tx,
        );
      }

      return { shipmentId: header.id, docNo, status: 'PLANNED' as const };
    });
  }

  /** 부킹: PLANNED → BOOKED, optionally stamping the carrier / 운송서류번호 / 항차·편명 / ETD·ETA. */
  async book(id: string, dto: BookShipmentDto, actor = 'system') {
    return this.advance(
      id,
      'PLANNED',
      'BOOKED',
      {
        ...(dto.transportDocNo !== undefined ? { transportDocNo: dto.transportDocNo } : {}),
        ...(dto.vesselFlightNo !== undefined ? { vesselFlightNo: dto.vesselFlightNo } : {}),
        ...(dto.carrier !== undefined ? { carrier: dto.carrier } : {}),
        ...(dto.etd !== undefined ? { etd: dto.etd } : {}),
        ...(dto.eta !== undefined ? { eta: dto.eta } : {}),
      },
      actor,
    );
  }

  /** 출항: BOOKED → DEPARTED. */
  async depart(id: string, actor = 'system') {
    return this.advance(id, 'BOOKED', 'DEPARTED', {}, actor);
  }

  /** 도착: DEPARTED → ARRIVED (terminal). */
  async arrive(id: string, actor = 'system') {
    return this.advance(id, 'DEPARTED', 'ARRIVED', {}, actor);
  }

  /** Header + items (line order) + outward lineage edges (CONTAINS), or 404. */
  async getShipment(id: string) {
    const [header] = await this.db.select().from(schema.shipment).where(eq(schema.shipment.id, id));
    if (!header) throw new NotFoundException(`shipment ${id} not found`);
    const items = await this.db
      .select()
      .from(schema.shipmentItem)
      .where(eq(schema.shipmentItem.shipmentId, id))
      .orderBy(asc(schema.shipmentItem.lineNo));
    const lineage = await this.docFlow.forward(DOC_FLOW_TYPE_SHIPMENT, id);
    return { ...header, items, lineage };
  }

  async listShipments(q: ShipmentQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.shipment)
      .where(this.listWhere(q))
      .orderBy(desc(schema.shipment.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countShipments(q: ShipmentQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.shipment)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: ShipmentQuery) {
    return and(
      q.companyCodeId ? eq(schema.shipment.companyCodeId, q.companyCodeId) : undefined,
      q.status ? eq(schema.shipment.status, q.status) : undefined,
      q.transportMode ? eq(schema.shipment.transportMode, q.transportMode) : undefined,
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
   * Resolve the deliveries (read-only): each must exist and belong to `companyCodeId` (checked via its SO,
   * since a delivery has no company column — the export-declaration resolveDelivery pattern, batched).
   */
  private async resolveDeliveries(deliveryIds: string[], companyCodeId: string) {
    const deliveries = await this.db
      .select({ id: schema.delivery.id, salesOrderId: schema.delivery.salesOrderId })
      .from(schema.delivery)
      .where(inArray(schema.delivery.id, deliveryIds));
    const byId = new Map(deliveries.map((d) => [d.id, d]));
    for (const id of deliveryIds) {
      if (!byId.has(id)) throw new NotFoundException(`delivery ${id} not found`);
    }
    const soIds = [...new Set(deliveries.map((d) => d.salesOrderId))];
    const sos = await this.db
      .select({ id: schema.salesOrder.id, companyCodeId: schema.salesOrder.companyCodeId })
      .from(schema.salesOrder)
      .where(inArray(schema.salesOrder.id, soIds));
    const soById = new Map(sos.map((s) => [s.id, s]));
    for (const d of deliveries) {
      const so = soById.get(d.salesOrderId);
      if (!so) {
        throw new NotFoundException(`sales order ${d.salesOrderId} for delivery ${d.id} not found`);
      }
      if (so.companyCodeId !== companyCodeId) {
        throw new BadRequestException(`delivery ${d.id} belongs to another company code`);
      }
    }
  }

  /**
   * Atomic forward transition guard: only a row still in `from` flips to `to` (a concurrent transition's loser
   * updates zero rows → 409), so the sequential lifecycle cannot be skipped or run backwards. `set` stamps any
   * extra fields (e.g. book()'s 운송서류번호). On a 0-row update, distinguish 404 from a wrong-status 409 and
   * report the legal next step (`nextShipmentStatus`).
   */
  private async advance(
    id: string,
    from: string,
    to: string,
    set: {
      transportDocNo?: string;
      vesselFlightNo?: string;
      carrier?: string;
      etd?: string;
      eta?: string;
    },
    actor: string,
  ) {
    const [updated] = await this.db
      .update(schema.shipment)
      .set({ status: to, ...set, updatedBy: actor, updatedAt: new Date() })
      .where(and(eq(schema.shipment.id, id), eq(schema.shipment.status, from)))
      .returning();
    if (updated) return updated;
    const [existing] = await this.db
      .select({ status: schema.shipment.status, docNo: schema.shipment.docNo })
      .from(schema.shipment)
      .where(eq(schema.shipment.id, id));
    if (!existing) throw new NotFoundException(`shipment ${id} not found`);
    const next = nextShipmentStatus(existing.status);
    throw new ConflictException(
      `shipment ${existing.docNo} is ${existing.status}; cannot transition to ${to} ` +
        `(the next legal step is ${next ?? '(none — terminal)'})`,
    );
  }
}
