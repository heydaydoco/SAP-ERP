import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import type { CreateMaterialDto, CreateTradeDataDto } from './material.dto.js';

/**
 * Material master service (master-data.material). One core material with an optional trade extension
 * (HS code + origin) — the §4.4 extension pattern. `create*` enforces uniqueness for the API;
 * idempotent `ensure*` helpers back the seed. sales/purchasing/mrp extensions arrive in later slices.
 */
@Injectable()
export class MaterialService {
  constructor(@Inject(DB) private readonly db: Database) {}

  // ── core material ──────────────────────────────────────────────────────────

  async createMaterial(dto: CreateMaterialDto, actor = 'system') {
    const existing = await this.db
      .select({ id: schema.material.id })
      .from(schema.material)
      .where(eq(schema.material.code, dto.code));
    if (existing.length > 0) throw new ConflictException(`material ${dto.code} already exists`);

    const [row] = await this.db
      .insert(schema.material)
      .values({ ...this.materialValues(dto), createdBy: actor, updatedBy: actor })
      .returning();
    return row;
  }

  async ensureMaterial(dto: CreateMaterialDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.material)
      .values({ ...this.materialValues(dto), createdBy: actor, updatedBy: actor })
      .onConflictDoNothing({ target: schema.material.code });
    const [row] = await this.db
      .select({ id: schema.material.id })
      .from(schema.material)
      .where(eq(schema.material.code, dto.code));
    if (!row) throw new Error(`material ${dto.code} missing after ensure`);
    return row.id;
  }

  async listMaterials(
    materialType: CreateMaterialDto['materialType'] | undefined,
    materialGroup: string | undefined,
    limit: number,
    offset: number,
  ) {
    const filters = [
      materialType ? eq(schema.material.materialType, materialType) : undefined,
      materialGroup ? eq(schema.material.materialGroup, materialGroup) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);
    return this.db
      .select()
      .from(schema.material)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(schema.material.code))
      .limit(limit)
      .offset(offset);
  }

  async countMaterials(
    materialType?: CreateMaterialDto['materialType'],
    materialGroup?: string,
  ): Promise<number> {
    const filters = [
      materialType ? eq(schema.material.materialType, materialType) : undefined,
      materialGroup ? eq(schema.material.materialGroup, materialGroup) : undefined,
    ].filter((f): f is NonNullable<typeof f> => f !== undefined);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.material)
      .where(filters.length ? and(...filters) : undefined);
    return row?.count ?? 0;
  }

  /** The core material plus its trade extension, or null where the trade view is absent. */
  async getMaterial(id: string) {
    const [mat] = await this.db.select().from(schema.material).where(eq(schema.material.id, id));
    if (!mat) throw new NotFoundException(`material ${id} not found`);
    const [trade] = await this.db
      .select()
      .from(schema.materialTrade)
      .where(eq(schema.materialTrade.materialId, id));
    return { ...mat, trade: trade ?? null };
  }

  // ── trade extension ────────────────────────────────────────────────────────

  async addTradeData(materialId: string, dto: CreateTradeDataDto, actor = 'system') {
    await this.assertMaterialExists(materialId);
    const existing = await this.db
      .select({ id: schema.materialTrade.id })
      .from(schema.materialTrade)
      .where(eq(schema.materialTrade.materialId, materialId));
    if (existing.length > 0) {
      throw new ConflictException(`material ${materialId} already has trade data`);
    }
    const [row] = await this.db
      .insert(schema.materialTrade)
      .values({ ...this.tradeValues(materialId, dto), createdBy: actor, updatedBy: actor })
      .returning();
    return row;
  }

  async ensureTradeData(
    materialId: string,
    dto: CreateTradeDataDto,
    actor = 'system',
  ): Promise<void> {
    await this.db
      .insert(schema.materialTrade)
      .values({ ...this.tradeValues(materialId, dto), createdBy: actor, updatedBy: actor })
      .onConflictDoNothing({ target: schema.materialTrade.materialId });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private materialValues(dto: CreateMaterialDto) {
    return {
      code: dto.code,
      name: dto.name,
      materialType: dto.materialType,
      baseUom: dto.baseUom,
      materialGroup: dto.materialGroup ?? null,
      netWeight: dto.netWeight ?? null,
      weightUnit: dto.weightUnit ?? null,
    };
  }

  private tradeValues(materialId: string, dto: CreateTradeDataDto) {
    return {
      materialId,
      hsCode: dto.hsCode,
      countryOfOrigin: dto.countryOfOrigin ?? null,
      exportControlClass: dto.exportControlClass ?? null,
    };
  }

  private async assertMaterialExists(materialId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: schema.material.id })
      .from(schema.material)
      .where(eq(schema.material.id, materialId));
    if (!row) throw new NotFoundException(`material ${materialId} not found`);
  }
}
