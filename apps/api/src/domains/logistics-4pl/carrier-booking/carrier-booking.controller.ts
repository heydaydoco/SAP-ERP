import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { CarrierBookingService } from './carrier-booking.service.js';
import {
  carrierBookingQuerySchema,
  createCarrierBookingSchema,
  type CarrierBookingQuery,
  type CreateCarrierBookingDto,
} from './carrier-booking.dto.js';

@Controller('logistics-4pl')
export class CarrierBookingController {
  constructor(private readonly carrierBookings: CarrierBookingService) {}

  @RequirePermissions('logistics_4pl:carrier_booking:create')
  @Post('carrier-bookings')
  create(
    @Body(new ZodValidationPipe(createCarrierBookingSchema)) dto: CreateCarrierBookingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.carrierBookings.create(dto, user.username);
  }

  /** Filtered, paginated bookings. Filter `?shipmentId=` for one shipment's bookings. */
  @RequirePermissions('logistics_4pl:carrier_booking:read')
  @Get('carrier-bookings')
  async list(@Query(new ZodValidationPipe(carrierBookingQuerySchema)) q: CarrierBookingQuery) {
    const [rows, total] = await Promise.all([
      this.carrierBookings.listCarrierBookings(q, q.pageSize, toOffset(q)),
      this.carrierBookings.countCarrierBookings(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('logistics_4pl:carrier_booking:read')
  @Get('carrier-bookings/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.carrierBookings.getCarrierBooking(id);
  }
}
