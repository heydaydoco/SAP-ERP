import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { TaxCodeService } from './tax-code.service.js';
import {
  createTaxCodeSchema,
  taxCodeQuerySchema,
  taxQuoteSchema,
  type CreateTaxCodeDto,
  type TaxCodeQuery,
  type TaxQuoteQuery,
} from './tax-code.dto.js';

/** Tax-code master API (master-data.tax-code). Secure-by-default; reads paginated. */
@Controller('master-data')
export class TaxCodeController {
  constructor(private readonly taxCode: TaxCodeService) {}

  @RequirePermissions('master_data:tax_code:read')
  @Get('tax-codes')
  async listTaxCodes(@Query(new ZodValidationPipe(taxCodeQuerySchema)) q: TaxCodeQuery) {
    const [rows, total] = await Promise.all([
      this.taxCode.listTaxCodes(q.kind, q.pageSize, toOffset(q)),
      this.taxCode.countTaxCodes(q.kind),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('master_data:tax_code:create')
  @Post('tax-codes')
  createTaxCode(
    @Body(new ZodValidationPipe(createTaxCodeSchema)) dto: CreateTaxCodeDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.taxCode.createTaxCode(dto, user.username);
  }

  @RequirePermissions('master_data:tax_code:read')
  @Get('tax-codes/:code/quote')
  quote(
    @Param('code') code: string,
    @Query(new ZodValidationPipe(taxQuoteSchema)) q: TaxQuoteQuery,
  ) {
    return this.taxCode.quote(code, q.baseAmount, q.currency);
  }

  @RequirePermissions('master_data:tax_code:read')
  @Get('tax-codes/:id')
  getTaxCode(@Param('id', ParseUUIDPipe) id: string) {
    return this.taxCode.getTaxCode(id);
  }
}
