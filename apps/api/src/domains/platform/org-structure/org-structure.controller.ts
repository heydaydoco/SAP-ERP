import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginationQuerySchema, type PaginationQuery } from '@erp/shared';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RequirePermissions } from '../rbac/permissions.decorator.js';
import { OrgStructureService } from './org-structure.service.js';
import {
  byCompanyQuerySchema,
  byPlantQuerySchema,
  createCompanyCodeSchema,
  createPlantSchema,
  createPurchasingOrgSchema,
  createSalesOrgSchema,
  createStorageLocationSchema,
  type ByCompanyQuery,
  type ByPlantQuery,
  type CreateCompanyCodeDto,
  type CreatePlantDto,
  type CreatePurchasingOrgDto,
  type CreateSalesOrgDto,
  type CreateStorageLocationDto,
} from './org-structure.dto.js';

/**
 * Enterprise structure API (platform.org-structure). Secure-by-default: the global JwtAuthGuard +
 * PermissionsGuard apply, so every route requires authentication and the declared
 * `platform:org_structure:*` permission. Reads are paginated via the shared envelope; the acting
 * user fills the audit-4 actor on writes.
 */
@Controller('org')
export class OrgStructureController {
  constructor(private readonly org: OrgStructureService) {}

  // ── company code ───────────────────────────────────────────────────────────

  @RequirePermissions('platform:org_structure:read')
  @Get('company-codes')
  async listCompanyCodes(@Query(new ZodValidationPipe(paginationQuerySchema)) q: PaginationQuery) {
    const [rows, total] = await Promise.all([
      this.org.listCompanyCodes(q.pageSize, toOffset(q)),
      this.org.countCompanyCodes(),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('platform:org_structure:create')
  @Post('company-codes')
  createCompanyCode(
    @Body(new ZodValidationPipe(createCompanyCodeSchema))
    dto: CreateCompanyCodeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.org.createCompanyCode(dto, user.username);
  }

  @RequirePermissions('platform:org_structure:read')
  @Get('company-codes/:id')
  getCompanyCode(@Param('id', ParseUUIDPipe) id: string) {
    return this.org.getCompanyCode(id);
  }

  // ── plant ──────────────────────────────────────────────────────────────────

  @RequirePermissions('platform:org_structure:read')
  @Get('plants')
  async listPlants(@Query(new ZodValidationPipe(byCompanyQuerySchema)) q: ByCompanyQuery) {
    const [rows, total] = await Promise.all([
      this.org.listPlants(q.companyCodeId, q.pageSize, toOffset(q)),
      this.org.countPlants(q.companyCodeId),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('platform:org_structure:create')
  @Post('plants')
  createPlant(
    @Body(new ZodValidationPipe(createPlantSchema)) dto: CreatePlantDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.org.createPlant(dto, user.username);
  }

  // ── storage location ─────────────────────────────────────────────────────────

  @RequirePermissions('platform:org_structure:read')
  @Get('storage-locations')
  async listStorageLocations(@Query(new ZodValidationPipe(byPlantQuerySchema)) q: ByPlantQuery) {
    const [rows, total] = await Promise.all([
      this.org.listStorageLocations(q.plantId, q.pageSize, toOffset(q)),
      this.org.countStorageLocations(q.plantId),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('platform:org_structure:create')
  @Post('storage-locations')
  createStorageLocation(
    @Body(new ZodValidationPipe(createStorageLocationSchema))
    dto: CreateStorageLocationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.org.createStorageLocation(dto, user.username);
  }

  // ── sales org ────────────────────────────────────────────────────────────────

  @RequirePermissions('platform:org_structure:read')
  @Get('sales-orgs')
  async listSalesOrgs(@Query(new ZodValidationPipe(byCompanyQuerySchema)) q: ByCompanyQuery) {
    const [rows, total] = await Promise.all([
      this.org.listSalesOrgs(q.companyCodeId, q.pageSize, toOffset(q)),
      this.org.countSalesOrgs(q.companyCodeId),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('platform:org_structure:create')
  @Post('sales-orgs')
  createSalesOrg(
    @Body(new ZodValidationPipe(createSalesOrgSchema)) dto: CreateSalesOrgDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.org.createSalesOrg(dto, user.username);
  }

  // ── purchasing org ─────────────────────────────────────────────────────────

  @RequirePermissions('platform:org_structure:read')
  @Get('purchasing-orgs')
  async listPurchasingOrgs(@Query(new ZodValidationPipe(byCompanyQuerySchema)) q: ByCompanyQuery) {
    const [rows, total] = await Promise.all([
      this.org.listPurchasingOrgs(q.companyCodeId, q.pageSize, toOffset(q)),
      this.org.countPurchasingOrgs(q.companyCodeId),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('platform:org_structure:create')
  @Post('purchasing-orgs')
  createPurchasingOrg(
    @Body(new ZodValidationPipe(createPurchasingOrgSchema))
    dto: CreatePurchasingOrgDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.org.createPurchasingOrg(dto, user.username);
  }
}
