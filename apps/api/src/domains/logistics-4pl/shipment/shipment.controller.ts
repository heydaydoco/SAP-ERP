import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { ShipmentService } from './shipment.service.js';
import {
  bookShipmentSchema,
  createShipmentSchema,
  shipmentQuerySchema,
  type BookShipmentDto,
  type CreateShipmentDto,
  type ShipmentQuery,
} from './shipment.dto.js';

@Controller('logistics-4pl')
export class ShipmentController {
  constructor(private readonly shipments: ShipmentService) {}

  @RequirePermissions('logistics_4pl:shipment:create')
  @Post('shipments')
  create(
    @Body(new ZodValidationPipe(createShipmentSchema)) dto: CreateShipmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.shipments.create(dto, user.username);
  }

  /** 부킹: PLANNED → BOOKED (optionally stamp 운송서류번호 등). */
  @RequirePermissions('logistics_4pl:shipment:book')
  @Post('shipments/:id/book')
  book(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(bookShipmentSchema)) dto: BookShipmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.shipments.book(id, dto, user.username);
  }

  /** 출항: BOOKED → DEPARTED. */
  @RequirePermissions('logistics_4pl:shipment:depart')
  @Post('shipments/:id/depart')
  depart(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.shipments.depart(id, user.username);
  }

  /** 도착: DEPARTED → ARRIVED. */
  @RequirePermissions('logistics_4pl:shipment:arrive')
  @Post('shipments/:id/arrive')
  arrive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.shipments.arrive(id, user.username);
  }

  @RequirePermissions('logistics_4pl:shipment:read')
  @Get('shipments')
  async list(@Query(new ZodValidationPipe(shipmentQuerySchema)) q: ShipmentQuery) {
    const [rows, total] = await Promise.all([
      this.shipments.listShipments(q, q.pageSize, toOffset(q)),
      this.shipments.countShipments(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('logistics_4pl:shipment:read')
  @Get('shipments/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.shipments.getShipment(id);
  }
}
