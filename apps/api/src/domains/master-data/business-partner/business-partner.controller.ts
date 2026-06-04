import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { BusinessPartnerService } from './business-partner.service.js';
import {
  bpQuerySchema,
  createBpSchema,
  createCustomerRoleSchema,
  createVendorRoleSchema,
  type BpQuery,
  type CreateBpDto,
  type CreateCustomerRoleDto,
  type CreateVendorRoleDto,
} from './business-partner.dto.js';

/**
 * Business-partner master API (master-data.business-partner). Secure-by-default; reads paginated.
 * The core partner is created first, then customer/vendor roles are attached to it.
 */
@Controller('master-data')
export class BusinessPartnerController {
  constructor(private readonly bp: BusinessPartnerService) {}

  @RequirePermissions('master_data:business_partner:read')
  @Get('business-partners')
  async listBps(@Query(new ZodValidationPipe(bpQuerySchema)) q: BpQuery) {
    const [rows, total] = await Promise.all([
      this.bp.listBps(q.bpType, q.pageSize, toOffset(q)),
      this.bp.countBps(q.bpType),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('master_data:business_partner:create')
  @Post('business-partners')
  createBp(
    @Body(new ZodValidationPipe(createBpSchema)) dto: CreateBpDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bp.createBp(dto, user.username);
  }

  @RequirePermissions('master_data:business_partner:read')
  @Get('business-partners/:id')
  getBp(@Param('id', ParseUUIDPipe) id: string) {
    return this.bp.getBp(id);
  }

  @RequirePermissions('master_data:business_partner:manage_role')
  @Post('business-partners/:id/customer-role')
  addCustomerRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createCustomerRoleSchema)) dto: CreateCustomerRoleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bp.addCustomerRole(id, dto, user.username);
  }

  @RequirePermissions('master_data:business_partner:manage_role')
  @Post('business-partners/:id/vendor-role')
  addVendorRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createVendorRoleSchema)) dto: CreateVendorRoleDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bp.addVendorRole(id, dto, user.username);
  }
}
