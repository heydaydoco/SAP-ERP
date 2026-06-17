import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { LandedCostService } from './landed-cost.service.js';
import { createLandedCostSchema, type CreateLandedCostDto } from './landed-cost.dto.js';

@Controller('procurement')
export class LandedCostController {
  constructor(private readonly landedCosts: LandedCostService) {}

  @RequirePermissions('procurement:landed_cost:post')
  @Post('landed-costs')
  post(
    @Body(new ZodValidationPipe(createLandedCostSchema)) dto: CreateLandedCostDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.landedCosts.post(dto, user.username);
  }

  @RequirePermissions('procurement:landed_cost:read')
  @Get('landed-costs/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.landedCosts.getLandedCost(id);
  }

  @RequirePermissions('procurement:landed_cost:read')
  @Get('purchase-orders/:id/landed-costs')
  listForPo(@Param('id', ParseUUIDPipe) id: string) {
    return this.landedCosts.listForPurchaseOrder(id);
  }
}
