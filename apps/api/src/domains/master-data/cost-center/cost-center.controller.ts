import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { CostCenterService } from './cost-center.service.js';
import {
  costCenterQuerySchema,
  createCostCenterSchema,
  type CostCenterQuery,
  type CreateCostCenterDto,
} from './cost-center.dto.js';

/** Cost-center master API (master-data.cost-center). Secure-by-default; reads paginated. */
@Controller('master-data')
export class CostCenterController {
  constructor(private readonly costCenter: CostCenterService) {}

  @RequirePermissions('master_data:cost_center:read')
  @Get('cost-centers')
  async listCostCenters(@Query(new ZodValidationPipe(costCenterQuerySchema)) q: CostCenterQuery) {
    const [rows, total] = await Promise.all([
      this.costCenter.listCostCenters(q.companyCodeId, q.pageSize, toOffset(q)),
      this.costCenter.countCostCenters(q.companyCodeId),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('master_data:cost_center:create')
  @Post('cost-centers')
  createCostCenter(
    @Body(new ZodValidationPipe(createCostCenterSchema)) dto: CreateCostCenterDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.costCenter.createCostCenter(dto, user.username);
  }

  @RequirePermissions('master_data:cost_center:read')
  @Get('cost-centers/:id')
  getCostCenter(@Param('id', ParseUUIDPipe) id: string) {
    return this.costCenter.getCostCenter(id);
  }
}
