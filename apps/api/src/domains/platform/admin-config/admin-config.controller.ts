import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth.types.js';
import { RequirePermissions } from '../rbac/permissions.decorator.js';
import { AccountDeterminationService } from './account-determination.service.js';
import { FiscalPeriodService } from './fiscal-period.service.js';
import {
  accountDeterminationQuerySchema,
  createAccountDeterminationSchema,
  fiscalYearsQuerySchema,
  generateFiscalYearSchema,
  resolveAccountQuerySchema,
  type AccountDeterminationQuery,
  type CreateAccountDeterminationDto,
  type FiscalYearsQuery,
  type GenerateFiscalYearDto,
  type ResolveAccountQuery,
} from './admin-config.dto.js';

/**
 * Admin-config API (platform.admin-config = SAP IMG). Fiscal-period control + account-determination
 * maintenance. Secure-by-default: global guards apply; reads need `:read`, mutations `:manage`.
 */
@Controller('admin-config')
export class AdminConfigController {
  constructor(
    private readonly fiscal: FiscalPeriodService,
    private readonly accounts: AccountDeterminationService,
  ) {}

  // ── fiscal periods ───────────────────────────────────────────────────────────

  @RequirePermissions('platform:fiscal_period:read')
  @Get('fiscal-years')
  async listFiscalYears(@Query(new ZodValidationPipe(fiscalYearsQuerySchema)) q: FiscalYearsQuery) {
    const [rows, total] = await Promise.all([
      this.fiscal.listYears(q.companyCodeId, q.pageSize, toOffset(q)),
      this.fiscal.countYears(q.companyCodeId),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('platform:fiscal_period:manage')
  @Post('fiscal-years')
  async generateFiscalYear(
    @Body(new ZodValidationPipe(generateFiscalYearSchema)) dto: GenerateFiscalYearDto,
    @CurrentUser() user: AuthUser,
  ) {
    const id = await this.fiscal.generateYear(dto.companyCodeId, dto.year, user.username);
    return this.fiscal.listPeriods(id).then((periods) => ({ fiscalYearId: id, periods }));
  }

  @RequirePermissions('platform:fiscal_period:read')
  @Get('fiscal-years/:id/periods')
  listPeriods(@Param('id', ParseUUIDPipe) id: string) {
    return this.fiscal.listPeriods(id);
  }

  @RequirePermissions('platform:fiscal_period:manage')
  @Post('fiscal-periods/:id/close')
  closePeriod(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.fiscal.closePeriod(id, user.username);
  }

  @RequirePermissions('platform:fiscal_period:manage')
  @Post('fiscal-periods/:id/open')
  openPeriod(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.fiscal.openPeriod(id, user.username);
  }

  // ── account determination ─────────────────────────────────────────────────────

  @RequirePermissions('platform:account_determination:read')
  @Get('account-determination')
  async listAccountDetermination(
    @Query(new ZodValidationPipe(accountDeterminationQuerySchema)) q: AccountDeterminationQuery,
  ) {
    const [rows, total] = await Promise.all([
      this.accounts.list(q.chartOfAccounts, q.pageSize, toOffset(q)),
      this.accounts.count(q.chartOfAccounts),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('platform:account_determination:manage')
  @Post('account-determination')
  defineRule(
    @Body(new ZodValidationPipe(createAccountDeterminationSchema))
    dto: CreateAccountDeterminationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.accounts.defineRule(dto, user.username);
  }

  @RequirePermissions('platform:account_determination:read')
  @Get('account-determination/resolve')
  async resolve(@Query(new ZodValidationPipe(resolveAccountQuerySchema)) q: ResolveAccountQuery) {
    const glAccount = await this.accounts.resolve(q);
    return { glAccount };
  }
}
