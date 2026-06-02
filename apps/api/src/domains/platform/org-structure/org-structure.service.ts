import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import type {
  CreateCompanyCodeDto,
  CreatePlantDto,
  CreatePurchasingOrgDto,
  CreateSalesOrgDto,
  CreateStorageLocationDto,
} from './org-structure.dto.js';

/**
 * Enterprise structure service (platform.org-structure). Manages SAP organizational units —
 * company code → plant → storage location, plus sales/purchasing orgs. `create*` enforces business
 * keys (parent must exist; code unique within parent) and is what the controller exposes; the
 * idempotent `ensure*` helpers (returning the id) are what the seed uses so it is re-runnable.
 */
@Injectable()
export class OrgStructureService {
  constructor(@Inject(DB) private readonly db: Database) {}

  // ── company code ───────────────────────────────────────────────────────────

  async createCompanyCode(dto: CreateCompanyCodeDto, actor = 'system') {
    const existing = await this.db
      .select({ id: schema.companyCode.id })
      .from(schema.companyCode)
      .where(eq(schema.companyCode.code, dto.code));
    if (existing.length > 0) throw new ConflictException(`company code ${dto.code} already exists`);

    const [row] = await this.db
      .insert(schema.companyCode)
      .values({
        code: dto.code,
        name: dto.name,
        currency: dto.currency,
        country: dto.country,
        chartOfAccounts: dto.chartOfAccounts ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return row;
  }

  /** Idempotent: create if absent, return the id either way. */
  async ensureCompanyCode(dto: CreateCompanyCodeDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.companyCode)
      .values({
        code: dto.code,
        name: dto.name,
        currency: dto.currency,
        country: dto.country,
        chartOfAccounts: dto.chartOfAccounts ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({ target: schema.companyCode.code });
    const [row] = await this.db
      .select({ id: schema.companyCode.id })
      .from(schema.companyCode)
      .where(eq(schema.companyCode.code, dto.code));
    if (!row) throw new Error(`company code ${dto.code} missing after ensure`);
    return row.id;
  }

  async listCompanyCodes(limit: number, offset: number) {
    return this.db
      .select()
      .from(schema.companyCode)
      .orderBy(asc(schema.companyCode.code))
      .limit(limit)
      .offset(offset);
  }

  async countCompanyCodes(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.companyCode);
    return row?.count ?? 0;
  }

  async getCompanyCode(id: string) {
    const [row] = await this.db
      .select()
      .from(schema.companyCode)
      .where(eq(schema.companyCode.id, id));
    if (!row) throw new NotFoundException(`company code ${id} not found`);
    return row;
  }

  // ── plant ──────────────────────────────────────────────────────────────────

  async createPlant(dto: CreatePlantDto, actor = 'system') {
    await this.assertCompanyExists(dto.companyCodeId);
    const dup = await this.db
      .select({ id: schema.plant.id })
      .from(schema.plant)
      .where(
        and(eq(schema.plant.companyCodeId, dto.companyCodeId), eq(schema.plant.code, dto.code)),
      );
    if (dup.length > 0) {
      throw new ConflictException(`plant ${dto.code} already exists in this company code`);
    }

    const [row] = await this.db
      .insert(schema.plant)
      .values({
        code: dto.code,
        name: dto.name,
        companyCodeId: dto.companyCodeId,
        country: dto.country ?? null,
        city: dto.city ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return row;
  }

  async ensurePlant(dto: CreatePlantDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.plant)
      .values({
        code: dto.code,
        name: dto.name,
        companyCodeId: dto.companyCodeId,
        country: dto.country ?? null,
        city: dto.city ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({
        target: [schema.plant.companyCodeId, schema.plant.code],
      });
    const [row] = await this.db
      .select({ id: schema.plant.id })
      .from(schema.plant)
      .where(
        and(eq(schema.plant.companyCodeId, dto.companyCodeId), eq(schema.plant.code, dto.code)),
      );
    if (!row) throw new Error(`plant ${dto.code} missing after ensure`);
    return row.id;
  }

  async listPlants(companyCodeId: string | undefined, limit: number, offset: number) {
    const where = companyCodeId ? eq(schema.plant.companyCodeId, companyCodeId) : undefined;
    return this.db
      .select()
      .from(schema.plant)
      .where(where)
      .orderBy(asc(schema.plant.code))
      .limit(limit)
      .offset(offset);
  }

  async countPlants(companyCodeId?: string): Promise<number> {
    const where = companyCodeId ? eq(schema.plant.companyCodeId, companyCodeId) : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.plant)
      .where(where);
    return row?.count ?? 0;
  }

  // ── storage location ─────────────────────────────────────────────────────────

  async createStorageLocation(dto: CreateStorageLocationDto, actor = 'system') {
    await this.assertPlantExists(dto.plantId);
    const dup = await this.db
      .select({ id: schema.storageLocation.id })
      .from(schema.storageLocation)
      .where(
        and(
          eq(schema.storageLocation.plantId, dto.plantId),
          eq(schema.storageLocation.code, dto.code),
        ),
      );
    if (dup.length > 0) {
      throw new ConflictException(`storage location ${dto.code} already exists in this plant`);
    }

    const [row] = await this.db
      .insert(schema.storageLocation)
      .values({
        code: dto.code,
        name: dto.name,
        plantId: dto.plantId,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return row;
  }

  async ensureStorageLocation(dto: CreateStorageLocationDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.storageLocation)
      .values({
        code: dto.code,
        name: dto.name,
        plantId: dto.plantId,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({
        target: [schema.storageLocation.plantId, schema.storageLocation.code],
      });
    const [row] = await this.db
      .select({ id: schema.storageLocation.id })
      .from(schema.storageLocation)
      .where(
        and(
          eq(schema.storageLocation.plantId, dto.plantId),
          eq(schema.storageLocation.code, dto.code),
        ),
      );
    if (!row) throw new Error(`storage location ${dto.code} missing after ensure`);
    return row.id;
  }

  async listStorageLocations(plantId: string | undefined, limit: number, offset: number) {
    const where = plantId ? eq(schema.storageLocation.plantId, plantId) : undefined;
    return this.db
      .select()
      .from(schema.storageLocation)
      .where(where)
      .orderBy(asc(schema.storageLocation.code))
      .limit(limit)
      .offset(offset);
  }

  async countStorageLocations(plantId?: string): Promise<number> {
    const where = plantId ? eq(schema.storageLocation.plantId, plantId) : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.storageLocation)
      .where(where);
    return row?.count ?? 0;
  }

  // ── sales org ────────────────────────────────────────────────────────────────

  async createSalesOrg(dto: CreateSalesOrgDto, actor = 'system') {
    await this.assertCompanyExists(dto.companyCodeId);
    const dup = await this.db
      .select({ id: schema.salesOrg.id })
      .from(schema.salesOrg)
      .where(
        and(
          eq(schema.salesOrg.companyCodeId, dto.companyCodeId),
          eq(schema.salesOrg.code, dto.code),
        ),
      );
    if (dup.length > 0) {
      throw new ConflictException(`sales org ${dto.code} already exists in this company code`);
    }

    const [row] = await this.db
      .insert(schema.salesOrg)
      .values({
        code: dto.code,
        name: dto.name,
        companyCodeId: dto.companyCodeId,
        currency: dto.currency ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return row;
  }

  async ensureSalesOrg(dto: CreateSalesOrgDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.salesOrg)
      .values({
        code: dto.code,
        name: dto.name,
        companyCodeId: dto.companyCodeId,
        currency: dto.currency ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({
        target: [schema.salesOrg.companyCodeId, schema.salesOrg.code],
      });
    const [row] = await this.db
      .select({ id: schema.salesOrg.id })
      .from(schema.salesOrg)
      .where(
        and(
          eq(schema.salesOrg.companyCodeId, dto.companyCodeId),
          eq(schema.salesOrg.code, dto.code),
        ),
      );
    if (!row) throw new Error(`sales org ${dto.code} missing after ensure`);
    return row.id;
  }

  async listSalesOrgs(companyCodeId: string | undefined, limit: number, offset: number) {
    const where = companyCodeId ? eq(schema.salesOrg.companyCodeId, companyCodeId) : undefined;
    return this.db
      .select()
      .from(schema.salesOrg)
      .where(where)
      .orderBy(asc(schema.salesOrg.code))
      .limit(limit)
      .offset(offset);
  }

  async countSalesOrgs(companyCodeId?: string): Promise<number> {
    const where = companyCodeId ? eq(schema.salesOrg.companyCodeId, companyCodeId) : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.salesOrg)
      .where(where);
    return row?.count ?? 0;
  }

  // ── purchasing org ─────────────────────────────────────────────────────────

  async createPurchasingOrg(dto: CreatePurchasingOrgDto, actor = 'system') {
    await this.assertCompanyExists(dto.companyCodeId);
    const dup = await this.db
      .select({ id: schema.purchasingOrg.id })
      .from(schema.purchasingOrg)
      .where(
        and(
          eq(schema.purchasingOrg.companyCodeId, dto.companyCodeId),
          eq(schema.purchasingOrg.code, dto.code),
        ),
      );
    if (dup.length > 0) {
      throw new ConflictException(`purchasing org ${dto.code} already exists in this company code`);
    }

    const [row] = await this.db
      .insert(schema.purchasingOrg)
      .values({
        code: dto.code,
        name: dto.name,
        companyCodeId: dto.companyCodeId,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return row;
  }

  async ensurePurchasingOrg(dto: CreatePurchasingOrgDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.purchasingOrg)
      .values({
        code: dto.code,
        name: dto.name,
        companyCodeId: dto.companyCodeId,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({
        target: [schema.purchasingOrg.companyCodeId, schema.purchasingOrg.code],
      });
    const [row] = await this.db
      .select({ id: schema.purchasingOrg.id })
      .from(schema.purchasingOrg)
      .where(
        and(
          eq(schema.purchasingOrg.companyCodeId, dto.companyCodeId),
          eq(schema.purchasingOrg.code, dto.code),
        ),
      );
    if (!row) throw new Error(`purchasing org ${dto.code} missing after ensure`);
    return row.id;
  }

  async listPurchasingOrgs(companyCodeId: string | undefined, limit: number, offset: number) {
    const where = companyCodeId ? eq(schema.purchasingOrg.companyCodeId, companyCodeId) : undefined;
    return this.db
      .select()
      .from(schema.purchasingOrg)
      .where(where)
      .orderBy(asc(schema.purchasingOrg.code))
      .limit(limit)
      .offset(offset);
  }

  async countPurchasingOrgs(companyCodeId?: string): Promise<number> {
    const where = companyCodeId ? eq(schema.purchasingOrg.companyCodeId, companyCodeId) : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.purchasingOrg)
      .where(where);
    return row?.count ?? 0;
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async assertCompanyExists(companyCodeId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: schema.companyCode.id })
      .from(schema.companyCode)
      .where(eq(schema.companyCode.id, companyCodeId));
    if (!row) throw new NotFoundException(`company code ${companyCodeId} not found`);
  }

  private async assertPlantExists(plantId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: schema.plant.id })
      .from(schema.plant)
      .where(eq(schema.plant.id, plantId));
    if (!row) throw new NotFoundException(`plant ${plantId} not found`);
  }
}
