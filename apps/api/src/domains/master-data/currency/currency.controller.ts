import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginationQuerySchema, type PaginationQuery } from '@erp/shared';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { CurrencyService } from './currency.service.js';
import {
  createCurrencySchema,
  createFxRateSchema,
  fxRateQuerySchema,
  resolveFxRateSchema,
  type CreateCurrencyDto,
  type CreateFxRateDto,
  type FxRateQuery,
  type ResolveFxRateQuery,
} from './currency.dto.js';

/**
 * Currency + FX-rate master API (master-data.currency). Secure-by-default via the global
 * JwtAuthGuard + PermissionsGuard; reads use the shared pagination envelope and writes stamp the
 * acting user as the audit actor.
 */
@Controller('master-data')
export class CurrencyController {
  constructor(private readonly currency: CurrencyService) {}

  // ── currency ─────────────────────────────────────────────────────────────────

  @RequirePermissions('master_data:currency:read')
  @Get('currencies')
  async listCurrencies(@Query(new ZodValidationPipe(paginationQuerySchema)) q: PaginationQuery) {
    const [rows, total] = await Promise.all([
      this.currency.listCurrencies(q.pageSize, toOffset(q)),
      this.currency.countCurrencies(),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('master_data:currency:create')
  @Post('currencies')
  createCurrency(
    @Body(new ZodValidationPipe(createCurrencySchema)) dto: CreateCurrencyDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.currency.createCurrency(dto, user.username);
  }

  @RequirePermissions('master_data:currency:read')
  @Get('currencies/:id')
  getCurrency(@Param('id', ParseUUIDPipe) id: string) {
    return this.currency.getCurrency(id);
  }

  // ── fx rate ──────────────────────────────────────────────────────────────────

  @RequirePermissions('master_data:fx_rate:read')
  @Get('fx-rates')
  async listFxRates(@Query(new ZodValidationPipe(fxRateQuerySchema)) q: FxRateQuery) {
    const [rows, total] = await Promise.all([
      this.currency.listFxRates(q.fromCurrency, q.toCurrency, q.pageSize, toOffset(q)),
      this.currency.countFxRates(q.fromCurrency, q.toCurrency),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('master_data:fx_rate:read')
  @Get('fx-rates/resolve')
  resolveFxRate(@Query(new ZodValidationPipe(resolveFxRateSchema)) q: ResolveFxRateQuery) {
    return this.currency.resolveRate(q.fromCurrency, q.toCurrency, q.onDate, q.rateType);
  }

  @RequirePermissions('master_data:fx_rate:create')
  @Post('fx-rates')
  createFxRate(
    @Body(new ZodValidationPipe(createFxRateSchema)) dto: CreateFxRateDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.currency.createFxRate(dto, user.username);
  }
}
