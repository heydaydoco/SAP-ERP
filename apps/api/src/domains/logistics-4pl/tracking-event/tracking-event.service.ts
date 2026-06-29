import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import type { CreateTrackingEventDto, TrackingEventQuery } from './tracking-event.dto.js';

/**
 * Tracking-event service (logistics-4pl.tracking-event = 화물추적). Appends observed cargo milestones to a
 * shipment's timeline. **Posts NOTHING to FI** and **NEVER touches the shipment status machine** — an event is
 * a pure observation: it neither reads nor writes `shipment.status`, and the tracking enum is independent of
 * SHIPMENT_STATUS (the two are never converted/synced). No JournalService, no account-determination, no
 * posting_key, and **no doc_flow edge** — lineage is the `shipment_id` column alone (tracking_event is a
 * header-less, high-volume log, not a document; §4.3 / §3-C.5).
 *
 * Cross-domain reads are READ-ONLY (the shipment, for existence + company check) — never a write.
 */
@Injectable()
export class TrackingEventService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async createEvent(dto: CreateTrackingEventDto, actor = 'system') {
    await this.getCompany(dto.companyCodeId);
    // Shipment (READ-ONLY): must exist and belong to this company. The event never reads/writes its status.
    await this.resolveShipment(dto.shipmentId, dto.companyCodeId);

    // line_no = max+1 within the shipment (intake order, NOT timeline order). Optimistic compute-then-insert
    // with a bounded retry on the (shipment_id, line_no) unique race (the shipping-document.addDocument
    // pattern). There is NO business-duplicate guard — the same event_type may legitimately recur.
    for (let attempt = 0; ; attempt += 1) {
      const [maxRow] = await this.db
        .select({ max: sql<number>`coalesce(max(${schema.trackingEvent.lineNo}), 0)::int` })
        .from(schema.trackingEvent)
        .where(eq(schema.trackingEvent.shipmentId, dto.shipmentId));
      const nextLineNo = (maxRow?.max ?? 0) + 1;

      try {
        const [event] = await this.db
          .insert(schema.trackingEvent)
          .values({
            shipmentId: dto.shipmentId,
            lineNo: nextLineNo,
            eventType: dto.eventType,
            eventTime: dto.eventTime,
            location: dto.location ?? null,
            description: dto.description ?? null,
            createdBy: actor,
            updatedBy: actor,
          })
          .returning();
        return event;
      } catch (e) {
        // Lost the line_no race to a concurrent append → recompute the next line_no and retry (bounded). No
        // other unique exists (duplicate event_type is allowed), so nothing else is mapped here.
        if (isUniqueViolation(e, 'tracking_event_no_uq') && attempt < 3) continue;
        throw e;
      }
    }
  }

  /** A shipment's event timeline, chronological (`event_time` asc; `line_no` asc tie-break). */
  async listForShipment(shipmentId: string) {
    return this.db
      .select()
      .from(schema.trackingEvent)
      .where(eq(schema.trackingEvent.shipmentId, shipmentId))
      .orderBy(asc(schema.trackingEvent.eventTime), asc(schema.trackingEvent.lineNo));
  }

  /** Single event, or 404. */
  async getEvent(id: string) {
    const [event] = await this.db
      .select()
      .from(schema.trackingEvent)
      .where(eq(schema.trackingEvent.id, id));
    if (!event) throw new NotFoundException(`tracking event ${id} not found`);
    return event;
  }

  async listEvents(q: TrackingEventQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.trackingEvent)
      .where(this.listWhere(q))
      .orderBy(asc(schema.trackingEvent.eventTime), asc(schema.trackingEvent.lineNo))
      .limit(limit)
      .offset(offset);
  }

  async countEvents(q: TrackingEventQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.trackingEvent)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private listWhere(q: TrackingEventQuery) {
    return and(
      q.shipmentId ? eq(schema.trackingEvent.shipmentId, q.shipmentId) : undefined,
      q.eventType ? eq(schema.trackingEvent.eventType, q.eventType) : undefined,
      // tracking_event has no company column (it is a header-less log) — a company filter rides the owning
      // shipment via a correlated subquery, never a denormalized column.
      q.companyCodeId
        ? sql`${schema.trackingEvent.shipmentId} in (select ${schema.shipment.id} from ${schema.shipment} where ${schema.shipment.companyCodeId} = ${q.companyCodeId})`
        : undefined,
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
   * shipment's `status` is never read or written here — tracking is independent of the lifecycle.
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
}

/** True iff `e` is the Postgres unique violation for the named constraint. */
function isUniqueViolation(e: unknown, constraint: string): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint_name?: unknown };
  return err.code === '23505' && err.constraint_name === constraint;
}
