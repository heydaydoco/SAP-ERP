import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { DutyDrawbackService } from './duty-drawback.service.js';
import {
  approveDrawbackClaimSchema,
  createDrawbackClaimSchema,
  drawbackClaimQuerySchema,
  type ApproveDrawbackClaimDto,
  type CreateDrawbackClaimDto,
  type DrawbackClaimQuery,
} from './duty-drawback.dto.js';

@Controller('trade-compliance')
export class DutyDrawbackController {
  constructor(private readonly drawbacks: DutyDrawbackService) {}

  @RequirePermissions('trade_compliance:duty_drawback:create')
  @Post('drawback-claims')
  create(
    @Body(new ZodValidationPipe(createDrawbackClaimSchema)) dto: CreateDrawbackClaimDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drawbacks.create(dto, user.username);
  }

  /** approve (관세청 결정): post the FI journal (Dr 관세환급금 미수금 / Cr 관세환급수익) and flip CLAIMED → APPROVED. */
  @RequirePermissions('trade_compliance:duty_drawback:approve')
  @Post('drawback-claims/:id/approve')
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(approveDrawbackClaimSchema)) dto: ApproveDrawbackClaimDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.drawbacks.approve(id, dto, user.username);
  }

  @RequirePermissions('trade_compliance:duty_drawback:read')
  @Get('drawback-claims')
  async list(@Query(new ZodValidationPipe(drawbackClaimQuerySchema)) q: DrawbackClaimQuery) {
    const [rows, total] = await Promise.all([
      this.drawbacks.listDrawbackClaims(q, q.pageSize, toOffset(q)),
      this.drawbacks.countDrawbackClaims(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('trade_compliance:duty_drawback:read')
  @Get('drawback-claims/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.drawbacks.getDrawbackClaim(id);
  }
}
