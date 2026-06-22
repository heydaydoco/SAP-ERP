import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { PhysicalInventoryService } from './physical-inventory.service.js';
import {
  createPhysicalInventorySchema,
  physicalInventoryQuerySchema,
  type CreatePhysicalInventoryDto,
  type PhysicalInventoryQuery,
} from './physical-inventory.dto.js';

@Controller('inventory-warehouse')
export class PhysicalInventoryController {
  constructor(private readonly physicalInventory: PhysicalInventoryService) {}

  @RequirePermissions('inventory:physical_inventory:create')
  @Post('physical-inventories')
  count(
    @Body(new ZodValidationPipe(createPhysicalInventorySchema)) dto: CreatePhysicalInventoryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.physicalInventory.count(dto, user.username);
  }

  @RequirePermissions('inventory:physical_inventory:read')
  @Get('physical-inventories')
  async list(
    @Query(new ZodValidationPipe(physicalInventoryQuerySchema)) q: PhysicalInventoryQuery,
  ) {
    const [rows, total] = await Promise.all([
      this.physicalInventory.listPhysicalInventories(q, q.pageSize, toOffset(q)),
      this.physicalInventory.countPhysicalInventories(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('inventory:physical_inventory:read')
  @Get('physical-inventories/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.physicalInventory.getPhysicalInventory(id);
  }
}
