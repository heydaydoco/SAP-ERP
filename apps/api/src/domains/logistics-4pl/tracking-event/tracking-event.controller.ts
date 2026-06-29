import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { TrackingEventService } from './tracking-event.service.js';
import {
  createTrackingEventSchema,
  trackingEventQuerySchema,
  type CreateTrackingEventDto,
  type TrackingEventQuery,
} from './tracking-event.dto.js';

@Controller('logistics-4pl')
export class TrackingEventController {
  constructor(private readonly trackingEvents: TrackingEventService) {}

  @RequirePermissions('logistics_4pl:tracking_event:create')
  @Post('tracking-events')
  create(
    @Body(new ZodValidationPipe(createTrackingEventSchema)) dto: CreateTrackingEventDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.trackingEvents.createEvent(dto, user.username);
  }

  /** Filtered, paginated event feed (chronological — `event_time` asc). Filter `?shipmentId=` for one
   *  shipment's timeline. */
  @RequirePermissions('logistics_4pl:tracking_event:read')
  @Get('tracking-events')
  async list(@Query(new ZodValidationPipe(trackingEventQuerySchema)) q: TrackingEventQuery) {
    const [rows, total] = await Promise.all([
      this.trackingEvents.listEvents(q, q.pageSize, toOffset(q)),
      this.trackingEvents.countEvents(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('logistics_4pl:tracking_event:read')
  @Get('tracking-events/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.trackingEvents.getEvent(id);
  }
}
