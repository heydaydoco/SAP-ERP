import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { NumberingService } from '../../platform/numbering/numbering.service.js';
import { DocFlowService } from '../../platform/doc-flow/doc-flow.service.js';
import { BusinessPartnerService } from '../../master-data/business-partner/business-partner.service.js';
import {
  DOC_FLOW_TYPE_CARRIER_BOOKING,
  DOC_FLOW_TYPE_SHIPMENT,
  DOC_TYPE_CARRIER_BOOKING,
  NUMBER_OBJECT_CARRIER_BOOKING,
  REL_BOOKS,
} from '../logistics-4pl.constants.js';
import type { CarrierBookingQuery, CreateCarrierBookingDto } from './carrier-booking.dto.js';

/**
 * Carrier-booking service (logistics-4pl.carrier-booking = 운송수배). Registers a reservation placed with a
 * carrier (선사) for a shipment — its booking number + cut-off deadlines. **Posts NOTHING to FI** (freight is the
 * separate freight_settlement): no JournalService, no account-determination, no `posting_key`, no money/FX. Its
 * only linkage is a doc_flow `BOOKS` edge onto the shipment.
 *
 * **Never touches the shipment status machine** — it neither reads nor writes `shipment.status` (the
 * PLANNED→BOOKED lifecycle is `shipment.book()`'s job). Cross-domain reads are READ-ONLY: the shipment (exists +
 * same company) and the carrier BP (must carry a `carrier` role — NO recon substitution, the carrier role is
 * non-posting and has no reconciliation account). The first consumer of the `carrier` BP role (migration 0025).
 */
@Injectable()
export class CarrierBookingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly numbering: NumberingService,
    private readonly docFlow: DocFlowService,
    private readonly partners: BusinessPartnerService,
  ) {}

  async create(dto: CreateCarrierBookingDto, actor = 'system') {
    await this.getCompany(dto.companyCodeId);
    // Shipment (READ-ONLY): must exist and belong to this company. Its status is never read or written.
    await this.resolveShipment(dto.shipmentId, dto.companyCodeId);
    // Carrier (READ-ONLY): the BP must carry a carrier role. No recon account (non-posting).
    await this.resolveCarrier(dto.carrierBpId);

    return this.db.transaction(async (tx) => {
      const docNo = await this.numbering.next(NUMBER_OBJECT_CARRIER_BOOKING, 'GLOBAL', tx);
      const [header] = await tx
        .insert(schema.carrierBooking)
        .values({
          docType: DOC_TYPE_CARRIER_BOOKING,
          docNo,
          status: 'OPEN',
          companyCodeId: dto.companyCodeId,
          shipmentId: dto.shipmentId,
          carrierBpId: dto.carrierBpId,
          bookingNo: dto.bookingNo,
          cargoCutoff: dto.cargoCutoff ?? null,
          docCutoff: dto.docCutoff ?? null,
          vgmCutoff: dto.vgmCutoff ?? null,
          reference: dto.reference ?? null,
          headerText: dto.headerText ?? null,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning({ id: schema.carrierBooking.id });
      if (!header) throw new Error('carrier_booking insert returned no row');

      // Physical lineage (§4.3): the booking BOOKS the shipment. PLAIN string target (the doc_flow graph is
      // generic) — never a journal (the booking posts nothing).
      await this.docFlow.link(
        {
          sourceType: DOC_FLOW_TYPE_CARRIER_BOOKING,
          sourceId: header.id,
          targetType: DOC_FLOW_TYPE_SHIPMENT,
          targetId: dto.shipmentId,
          relType: REL_BOOKS,
        },
        tx,
      );

      return { carrierBookingId: header.id, docNo, status: 'OPEN' as const };
    });
  }

  /** Header + outward lineage edges (BOOKS), or 404. */
  async getCarrierBooking(id: string) {
    const [header] = await this.db
      .select()
      .from(schema.carrierBooking)
      .where(eq(schema.carrierBooking.id, id));
    if (!header) throw new NotFoundException(`carrier booking ${id} not found`);
    const lineage = await this.docFlow.forward(DOC_FLOW_TYPE_CARRIER_BOOKING, id);
    return { ...header, lineage };
  }

  /** A shipment's carrier bookings (drill-down), in doc order. */
  async listForShipment(shipmentId: string) {
    return this.db
      .select()
      .from(schema.carrierBooking)
      .where(eq(schema.carrierBooking.shipmentId, shipmentId))
      .orderBy(asc(schema.carrierBooking.docNo));
  }

  async listCarrierBookings(q: CarrierBookingQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.carrierBooking)
      .where(this.listWhere(q))
      .orderBy(desc(schema.carrierBooking.docNo))
      .limit(limit)
      .offset(offset);
  }

  async countCarrierBookings(q: CarrierBookingQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.carrierBooking)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: CarrierBookingQuery) {
    return and(
      q.companyCodeId ? eq(schema.carrierBooking.companyCodeId, q.companyCodeId) : undefined,
      q.shipmentId ? eq(schema.carrierBooking.shipmentId, q.shipmentId) : undefined,
      q.carrierBpId ? eq(schema.carrierBooking.carrierBpId, q.carrierBpId) : undefined,
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
   * → 400, an unknown one → 404). Mirrors the freight-settlement / shipping-document shipment guard. The
   * shipment's `status` is never read or written — booking is independent of the lifecycle.
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

  /**
   * Resolve the carrier (READ-ONLY): the BP must exist (`getBp` 404s otherwise) and carry a `carrier` role
   * (else 400). Mirrors freight-settlement's vendor-role check, but with NO recon substitution — the carrier
   * role is non-posting and has no reconciliation account.
   */
  private async resolveCarrier(carrierBpId: string) {
    const bp = await this.partners.getBp(carrierBpId);
    if (!bp.carrier) {
      throw new BadRequestException(`carrier ${carrierBpId} has no carrier role`);
    }
    return bp.carrier;
  }
}
