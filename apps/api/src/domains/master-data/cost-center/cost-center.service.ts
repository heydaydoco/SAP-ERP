import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import type { CreateCostCenterDto } from './cost-center.dto.js';

/**
 * Cost-center master service (master-data.cost-center). The CO object FI expense lines carry; scoped
 * to a company code (the parent must exist) with the code unique within it. `create*` enforces that;
 * idempotent `ensure*` backs the seed.
 */
@Injectable()
export class CostCenterService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async createCostCenter(dto: CreateCostCenterDto, actor = 'system') {
    await this.assertCompanyExists(dto.companyCodeId);
    const dup = await this.db
      .select({ id: schema.costCenter.id })
      .from(schema.costCenter)
      .where(this.key(dto.companyCodeId, dto.code));
    if (dup.length > 0) {
      throw new ConflictException(`cost center ${dto.code} already exists in this company code`);
    }

    const [row] = await this.db
      .insert(schema.costCenter)
      .values({
        code: dto.code,
        name: dto.name,
        companyCodeId: dto.companyCodeId,
        validFrom: dto.validFrom ?? null,
        validTo: dto.validTo ?? null,
        responsible: dto.responsible ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .returning();
    return row;
  }

  async ensureCostCenter(dto: CreateCostCenterDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.costCenter)
      .values({
        code: dto.code,
        name: dto.name,
        companyCodeId: dto.companyCodeId,
        validFrom: dto.validFrom ?? null,
        validTo: dto.validTo ?? null,
        responsible: dto.responsible ?? null,
        createdBy: actor,
        updatedBy: actor,
      })
      .onConflictDoNothing({
        target: [schema.costCenter.companyCodeId, schema.costCenter.code],
      });
    const [row] = await this.db
      .select({ id: schema.costCenter.id })
      .from(schema.costCenter)
      .where(this.key(dto.companyCodeId, dto.code));
    if (!row) throw new Error(`cost center ${dto.code} missing after ensure`);
    return row.id;
  }

  async listCostCenters(companyCodeId: string | undefined, limit: number, offset: number) {
    const where = companyCodeId ? eq(schema.costCenter.companyCodeId, companyCodeId) : undefined;
    return this.db
      .select()
      .from(schema.costCenter)
      .where(where)
      .orderBy(asc(schema.costCenter.code))
      .limit(limit)
      .offset(offset);
  }

  async countCostCenters(companyCodeId?: string): Promise<number> {
    const where = companyCodeId ? eq(schema.costCenter.companyCodeId, companyCodeId) : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.costCenter)
      .where(where);
    return row?.count ?? 0;
  }

  async getCostCenter(id: string) {
    const [row] = await this.db
      .select()
      .from(schema.costCenter)
      .where(eq(schema.costCenter.id, id));
    if (!row) throw new NotFoundException(`cost center ${id} not found`);
    return row;
  }

  private key(companyCodeId: string, code: string) {
    return and(
      eq(schema.costCenter.companyCodeId, companyCodeId),
      eq(schema.costCenter.code, code),
    );
  }

  private async assertCompanyExists(companyCodeId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: schema.companyCode.id })
      .from(schema.companyCode)
      .where(eq(schema.companyCode.id, companyCodeId));
    if (!row) throw new NotFoundException(`company code ${companyCodeId} not found`);
  }
}
