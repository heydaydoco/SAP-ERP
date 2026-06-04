import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { MaterialService } from './material.service.js';
import {
  createMaterialSchema,
  createTradeDataSchema,
  materialQuerySchema,
  type CreateMaterialDto,
  type CreateTradeDataDto,
  type MaterialQuery,
} from './material.dto.js';

/**
 * Material master API (master-data.material). Secure-by-default; reads paginated. The core material
 * is created first, then the trade extension is attached to it.
 */
@Controller('master-data')
export class MaterialController {
  constructor(private readonly material: MaterialService) {}

  @RequirePermissions('master_data:material:read')
  @Get('materials')
  async listMaterials(@Query(new ZodValidationPipe(materialQuerySchema)) q: MaterialQuery) {
    const [rows, total] = await Promise.all([
      this.material.listMaterials(q.materialType, q.materialGroup, q.pageSize, toOffset(q)),
      this.material.countMaterials(q.materialType, q.materialGroup),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('master_data:material:create')
  @Post('materials')
  createMaterial(
    @Body(new ZodValidationPipe(createMaterialSchema)) dto: CreateMaterialDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.material.createMaterial(dto, user.username);
  }

  @RequirePermissions('master_data:material:read')
  @Get('materials/:id')
  getMaterial(@Param('id', ParseUUIDPipe) id: string) {
    return this.material.getMaterial(id);
  }

  @RequirePermissions('master_data:material:manage_extension')
  @Post('materials/:id/trade-data')
  addTradeData(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(createTradeDataSchema)) dto: CreateTradeDataDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.material.addTradeData(id, dto, user.username);
  }
}
