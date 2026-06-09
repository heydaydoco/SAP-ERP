import { Body, Controller, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { ClearingService } from './clearing.service.js';
import {
  createClearingSchema,
  resetClearingSchema,
  type CreateClearingDto,
  type ResetClearingDto,
} from './clearing.dto.js';

/**
 * Clearing (payment) API (finance-accounting.clearing). A clearing is a posted journal — immutable
 * (§5.1); it is undone only by RESET (reverse of the clearing document), not edited. Both routes
 * write through the single `JournalService.post()` / `reverse()` path.
 */
@Controller('finance-accounting')
export class ClearingController {
  constructor(private readonly clearing: ClearingService) {}

  @RequirePermissions('finance:clearing:post')
  @Post('clearings')
  clear(
    @Body(new ZodValidationPipe(createClearingSchema)) dto: CreateClearingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.clearing.clear(dto, user.username);
  }

  @RequirePermissions('finance:clearing:reset')
  @Post('clearings/:id/reset')
  reset(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(resetClearingSchema)) dto: ResetClearingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.clearing.reset(id, dto, user.username);
  }
}
