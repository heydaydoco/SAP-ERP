import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import type { EnsureMaterialValuationDto, MaterialValuationQuery } from './material-valuation.dto.js';

/**
 * Material valuation maintenance — the material's "accounting view" per plant (§4.4 master
 * extension, like `material_trade`). The row MUST exist before the first goods movement: the
 * movement engine locks it (SELECT FOR UPDATE) to serialize MAP recalculation, and a lock needs a
 * row. `ensure*` is idempotent (`onConflictDoNothing` + re-select, repo convention); quantities,
 * value and the moving average are OWNED by the movement engine — this service never touches them.
 */
@Injectable()
export class MaterialValuationService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Create the accounting view if absent (idempotent); returns the live row either way. */
  async ensureValuation(dto: EnsureMaterialValuationDto, actor = 'system') {
    const [material] = await this.db
      .select({ id: schema.material.id })
      .from(schema.material)
      .where(eq(schema.material.id, dto.materialId));
    if (!material) throw new NotFoundException(`material ${dto.materialId} not found`);

    const [plant] = await this.db
      .select({ id: schema.plant.id, currency: schema.companyCode.currency })
      .from(schema.plant)
      .innerJoin(schema.companyCode, eq(schema.plant.companyCodeId, schema.companyCode.id))
      .where(eq(schema.plant.id, dto.plantId));
    if (!plant) throw new NotFoundException(`plant ${dto.plantId} not found`);

    // Valuation lives in the company's functional currency — a different pin is a config error.
    if (dto.currency && dto.currency !== plant.currency) {
      throw new BadRequestException(
        `valuation currency must be the company's functional currency ${plant.currency}`,
      );
    }

    await this.db
      .insert(schema.materialValuation)
      .values({
        materialId: dto.materialId,
        plantId: dto.plantId,
        valuationClass: dto.valuationClass,
        currency: plant.currency,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({
        target: [schema.materialValuation.materialId, schema.materialValuation.plantId],
      });

    const [row] = await this.db
      .select()
      .from(schema.materialValuation)
      .where(
        and(
          eq(schema.materialValuation.materialId, dto.materialId),
          eq(schema.materialValuation.plantId, dto.plantId),
        ),
      );
    if (!row) throw new Error('material_valuation missing after ensure');
    // Idempotent-ensure semantics — but silently "ensuring" a DIFFERENT class would mislead the
    // account determination; surface the mismatch instead (changing a class is a later concern).
    if (row.valuationClass !== dto.valuationClass) {
      throw new ConflictException(
        `material valuation already exists with valuation class ${row.valuationClass}`,
      );
    }
    return row;
  }

  async listValuations(q: MaterialValuationQuery, limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.materialValuation)
      .where(this.listWhere(q))
      .orderBy(asc(schema.materialValuation.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async countValuations(q: MaterialValuationQuery): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.materialValuation)
      .where(this.listWhere(q));
    return row?.count ?? 0;
  }

  /** Storage-location stock quantities for one material at one plant (qty lives in `stock`). */
  async listStock(materialId: string, plantId: string) {
    return this.db
      .select()
      .from(schema.stock)
      .where(and(eq(schema.stock.materialId, materialId), eq(schema.stock.plantId, plantId)))
      .orderBy(asc(schema.stock.createdAt));
  }

  private listWhere(q: MaterialValuationQuery) {
    return and(
      q.plantId ? eq(schema.materialValuation.plantId, q.plantId) : undefined,
      q.materialId ? eq(schema.materialValuation.materialId, q.materialId) : undefined,
    );
  }
}
