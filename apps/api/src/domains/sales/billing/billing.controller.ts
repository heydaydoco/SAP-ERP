import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { BillingService } from './billing.service.js';
import { createBillingSchema, type CreateBillingDto } from './billing.dto.js';

@Controller('sales')
export class BillingController {
  constructor(private readonly billings: BillingService) {}

  @RequirePermissions('sales:billing:post')
  @Post('billings')
  post(
    @Body(new ZodValidationPipe(createBillingSchema)) dto: CreateBillingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.billings.post(dto, user.username);
  }

  @RequirePermissions('sales:billing:read')
  @Get('billings/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.billings.getBilling(id);
  }
}
