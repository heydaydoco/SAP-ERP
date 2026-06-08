import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { ApInvoiceService } from './ap-invoice.service.js';
import {
  apOpenItemQuerySchema,
  createApInvoiceSchema,
  type ApOpenItemQuery,
  type CreateApInvoiceDto,
} from './ap-invoice.dto.js';

/**
 * Accounts-payable invoice API (finance-accounting.accounts-payable). Posting is the only write path
 * — a posted journal is immutable (§5.1); corrections go through the general-ledger reverse endpoint.
 * Open items are read straight off the recon-account subledger (D4).
 */
@Controller('finance-accounting')
export class ApInvoiceController {
  constructor(private readonly apInvoices: ApInvoiceService) {}

  @RequirePermissions('finance:ap_invoice:post')
  @Post('ap-invoices')
  post(
    @Body(new ZodValidationPipe(createApInvoiceSchema)) dto: CreateApInvoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.apInvoices.postApInvoice(dto, user.username);
  }

  @RequirePermissions('finance:ap_invoice:read')
  @Get('ap-invoices/open-items')
  openItems(@Query(new ZodValidationPipe(apOpenItemQuerySchema)) q: ApOpenItemQuery) {
    return this.apInvoices.listOpenItems(q);
  }
}
