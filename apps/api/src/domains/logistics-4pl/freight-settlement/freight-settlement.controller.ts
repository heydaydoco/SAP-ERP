import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { FreightSettlementService } from './freight-settlement.service.js';
import {
  createFreightSettlementSchema,
  freightSettlementQuerySchema,
  type CreateFreightSettlementDto,
  type FreightSettlementQuery,
} from './freight-settlement.dto.js';

@Controller('logistics-4pl')
export class FreightSettlementController {
  constructor(private readonly freight: FreightSettlementService) {}

  @RequirePermissions('logistics_4pl:freight_settlement:post')
  @Post('freight-settlements')
  post(
    @Body(new ZodValidationPipe(createFreightSettlementSchema)) dto: CreateFreightSettlementDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.freight.post(dto, user.username);
  }

  @RequirePermissions('logistics_4pl:freight_settlement:read')
  @Get('freight-settlements')
  async list(
    @Query(new ZodValidationPipe(freightSettlementQuerySchema)) q: FreightSettlementQuery,
  ) {
    const [rows, total] = await Promise.all([
      this.freight.listFreightSettlements(q, q.pageSize, toOffset(q)),
      this.freight.countFreightSettlements(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('logistics_4pl:freight_settlement:read')
  @Get('freight-settlements/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.freight.getFreightSettlement(id);
  }
}
