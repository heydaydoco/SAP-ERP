import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { GlAccountService } from './gl-account.service.js';
import {
  createGlAccountSchema,
  glAccountQuerySchema,
  type CreateGlAccountDto,
  type GlAccountQuery,
} from './gl-account.dto.js';

/** GL-account master API (master-data.gl-account). Secure-by-default; reads paginated. */
@Controller('master-data')
export class GlAccountController {
  constructor(private readonly glAccount: GlAccountService) {}

  @RequirePermissions('master_data:gl_account:read')
  @Get('gl-accounts')
  async listGlAccounts(@Query(new ZodValidationPipe(glAccountQuerySchema)) q: GlAccountQuery) {
    const [rows, total] = await Promise.all([
      this.glAccount.listGlAccounts(q.chartOfAccounts, q.pageSize, toOffset(q)),
      this.glAccount.countGlAccounts(q.chartOfAccounts),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('master_data:gl_account:create')
  @Post('gl-accounts')
  createGlAccount(
    @Body(new ZodValidationPipe(createGlAccountSchema)) dto: CreateGlAccountDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.glAccount.createGlAccount(dto, user.username);
  }

  @RequirePermissions('master_data:gl_account:read')
  @Get('gl-accounts/:id')
  getGlAccount(@Param('id', ParseUUIDPipe) id: string) {
    return this.glAccount.getGlAccount(id);
  }
}
