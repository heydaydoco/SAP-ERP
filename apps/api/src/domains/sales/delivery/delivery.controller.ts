import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { DeliveryService } from './delivery.service.js';
import { createDeliverySchema, type CreateDeliveryDto } from './delivery.dto.js';

@Controller('sales')
export class DeliveryController {
  constructor(private readonly deliveries: DeliveryService) {}

  @RequirePermissions('sales:delivery:post')
  @Post('deliveries')
  post(
    @Body(new ZodValidationPipe(createDeliverySchema)) dto: CreateDeliveryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deliveries.post(dto, user.username);
  }

  @RequirePermissions('sales:delivery:read')
  @Get('deliveries/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.getDelivery(id);
  }

  @RequirePermissions('sales:delivery:read')
  @Get('sales-orders/:id/deliveries')
  listForSo(@Param('id', ParseUUIDPipe) id: string) {
    return this.deliveries.listForSalesOrder(id);
  }
}
