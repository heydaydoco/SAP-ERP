import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import type {
  CreateBpDto,
  CreateCustomerRoleDto,
  CreateVendorRoleDto,
} from './business-partner.dto.js';

/**
 * Business-partner master service (master-data.business-partner). One core partner with optional
 * customer (AR) / vendor (AP) role extensions (§4.4). `create*` enforces uniqueness for the API;
 * idempotent `ensure*` helpers back the seed. Role writes validate that the reconciliation account
 * exists in the GL master so AR/AP postings (Phase 2) resolve.
 */
@Injectable()
export class BusinessPartnerService {
  constructor(@Inject(DB) private readonly db: Database) {}

  // ── core partner ───────────────────────────────────────────────────────────

  async createBp(dto: CreateBpDto, actor = 'system') {
    const existing = await this.db
      .select({ id: schema.businessPartner.id })
      .from(schema.businessPartner)
      .where(eq(schema.businessPartner.code, dto.code));
    if (existing.length > 0)
      throw new ConflictException(`business partner ${dto.code} already exists`);

    const [row] = await this.db
      .insert(schema.businessPartner)
      .values({ ...this.bpValues(dto), createdBy: actor, updatedBy: actor })
      .returning();
    return row;
  }

  async ensureBp(dto: CreateBpDto, actor = 'system'): Promise<string> {
    await this.db
      .insert(schema.businessPartner)
      .values({ ...this.bpValues(dto), createdBy: actor, updatedBy: actor })
      .onConflictDoNothing({ target: schema.businessPartner.code });
    const [row] = await this.db
      .select({ id: schema.businessPartner.id })
      .from(schema.businessPartner)
      .where(eq(schema.businessPartner.code, dto.code));
    if (!row) throw new Error(`business partner ${dto.code} missing after ensure`);
    return row.id;
  }

  async listBps(bpType: 'ORGANIZATION' | 'PERSON' | undefined, limit: number, offset: number) {
    const where = bpType ? eq(schema.businessPartner.bpType, bpType) : undefined;
    return this.db
      .select()
      .from(schema.businessPartner)
      .where(where)
      .orderBy(asc(schema.businessPartner.code))
      .limit(limit)
      .offset(offset);
  }

  async countBps(bpType?: 'ORGANIZATION' | 'PERSON'): Promise<number> {
    const where = bpType ? eq(schema.businessPartner.bpType, bpType) : undefined;
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.businessPartner)
      .where(where);
    return row?.count ?? 0;
  }

  /** The core partner plus whichever roles it has (customer/vendor), or null where a role is absent. */
  async getBp(id: string) {
    const [bp] = await this.db
      .select()
      .from(schema.businessPartner)
      .where(eq(schema.businessPartner.id, id));
    if (!bp) throw new NotFoundException(`business partner ${id} not found`);
    const [customer] = await this.db
      .select()
      .from(schema.customer)
      .where(eq(schema.customer.bpId, id));
    const [vendor] = await this.db.select().from(schema.vendor).where(eq(schema.vendor.bpId, id));
    return { ...bp, customer: customer ?? null, vendor: vendor ?? null };
  }

  // ── customer role ──────────────────────────────────────────────────────────

  async addCustomerRole(bpId: string, dto: CreateCustomerRoleDto, actor = 'system') {
    await this.assertBpExists(bpId);
    await this.assertReconAccount(dto.arReconAccount);
    const existing = await this.db
      .select({ id: schema.customer.id })
      .from(schema.customer)
      .where(eq(schema.customer.bpId, bpId));
    if (existing.length > 0) {
      throw new ConflictException(`business partner ${bpId} already has a customer role`);
    }
    const [row] = await this.db
      .insert(schema.customer)
      .values({ ...this.customerValues(bpId, dto), createdBy: actor, updatedBy: actor })
      .returning();
    return row;
  }

  async ensureCustomerRole(
    bpId: string,
    dto: CreateCustomerRoleDto,
    actor = 'system',
  ): Promise<void> {
    await this.assertReconAccount(dto.arReconAccount);
    await this.db
      .insert(schema.customer)
      .values({ ...this.customerValues(bpId, dto), createdBy: actor, updatedBy: actor })
      .onConflictDoNothing({ target: schema.customer.bpId });
  }

  // ── vendor role ────────────────────────────────────────────────────────────

  async addVendorRole(bpId: string, dto: CreateVendorRoleDto, actor = 'system') {
    await this.assertBpExists(bpId);
    await this.assertReconAccount(dto.apReconAccount);
    const existing = await this.db
      .select({ id: schema.vendor.id })
      .from(schema.vendor)
      .where(eq(schema.vendor.bpId, bpId));
    if (existing.length > 0) {
      throw new ConflictException(`business partner ${bpId} already has a vendor role`);
    }
    const [row] = await this.db
      .insert(schema.vendor)
      .values({ ...this.vendorValues(bpId, dto), createdBy: actor, updatedBy: actor })
      .returning();
    return row;
  }

  async ensureVendorRole(bpId: string, dto: CreateVendorRoleDto, actor = 'system'): Promise<void> {
    await this.assertReconAccount(dto.apReconAccount);
    await this.db
      .insert(schema.vendor)
      .values({ ...this.vendorValues(bpId, dto), createdBy: actor, updatedBy: actor })
      .onConflictDoNothing({ target: schema.vendor.bpId });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private bpValues(dto: CreateBpDto) {
    return {
      code: dto.code,
      name: dto.name,
      bpType: dto.bpType,
      taxId: dto.taxId ?? null,
      country: dto.country ?? null,
      city: dto.city ?? null,
      addressLine: dto.addressLine ?? null,
    };
  }

  private customerValues(bpId: string, dto: CreateCustomerRoleDto) {
    return {
      bpId,
      arReconAccount: dto.arReconAccount,
      creditLimit: dto.creditLimit ?? null,
      creditCurrency: dto.creditCurrency ?? null,
      paymentTermsDays: dto.paymentTermsDays ?? null,
      salesBlock: dto.salesBlock,
    };
  }

  private vendorValues(bpId: string, dto: CreateVendorRoleDto) {
    return {
      bpId,
      apReconAccount: dto.apReconAccount,
      paymentTermsDays: dto.paymentTermsDays ?? null,
      purchasingBlock: dto.purchasingBlock,
    };
  }

  private async assertBpExists(bpId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: schema.businessPartner.id })
      .from(schema.businessPartner)
      .where(eq(schema.businessPartner.id, bpId));
    if (!row) throw new NotFoundException(`business partner ${bpId} not found`);
  }

  /**
   * A role's reconciliation account must exist in the GL master AND be flagged
   * `is_reconciliation = true`. AR/AP postings hit it as a recon (subledger) line, and the open-item
   * subledger IS those recon lines (no second store) — a non-recon account here would post a line
   * that never surfaces in the subledger, so it is rejected at role assignment, not silently later.
   */
  private async assertReconAccount(accountNumber: string): Promise<void> {
    const [row] = await this.db
      .select({ isReconciliation: schema.glAccount.isReconciliation })
      .from(schema.glAccount)
      .where(eq(schema.glAccount.accountNumber, accountNumber));
    if (!row) throw new NotFoundException(`gl account ${accountNumber} not found`);
    if (!row.isReconciliation) {
      throw new BadRequestException(
        `gl account ${accountNumber} is not a reconciliation account; AR/AP roles must use one`,
      );
    }
  }
}
