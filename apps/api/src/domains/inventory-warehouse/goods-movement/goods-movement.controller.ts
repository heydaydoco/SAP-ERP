import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { GoodsMovementService } from './goods-movement.service.js';
import {
  createGoodsMovementSchema,
  goodsMovementQuerySchema,
  type CreateGoodsMovementDto,
  type GoodsMovementQuery,
} from './goods-movement.dto.js';

@Controller('inventory-warehouse')
export class GoodsMovementController {
  constructor(private readonly movements: GoodsMovementService) {}

  @RequirePermissions('inventory:goods_movement:post')
  @Post('goods-movements')
  postMovement(
    @Body(new ZodValidationPipe(createGoodsMovementSchema)) dto: CreateGoodsMovementDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.movements.post(dto, user.username);
  }

  @RequirePermissions('inventory:goods_movement:read')
  @Get('goods-movements')
  async listMovements(
    @Query(new ZodValidationPipe(goodsMovementQuerySchema)) q: GoodsMovementQuery,
  ) {
    const [rows, total] = await Promise.all([
      this.movements.listMovements(q, q.pageSize, toOffset(q)),
      this.movements.countMovements(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('inventory:goods_movement:read')
  @Get('goods-movements/:id')
  getMovement(@Param('id', ParseUUIDPipe) id: string) {
    return this.movements.getMovement(id);
  }
}
