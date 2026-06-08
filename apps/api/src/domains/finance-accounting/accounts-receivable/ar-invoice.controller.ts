import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { ArInvoiceService } from './ar-invoice.service.js';
import {
  arOpenItemQuerySchema,
  createArInvoiceSchema,
  type ArOpenItemQuery,
  type CreateArInvoiceDto,
} from './ar-invoice.dto.js';

/**
 * Accounts-receivable invoice API (finance-accounting.accounts-receivable). Posting is the only write
 * path — a posted journal is immutable (§5.1); corrections go through the general-ledger reverse
 * endpoint. Open items are read straight off the recon-account subledger (D4).
 */
@Controller('finance-accounting')
export class ArInvoiceController {
  constructor(private readonly arInvoices: ArInvoiceService) {}

  @RequirePermissions('finance:ar_invoice:post')
  @Post('ar-invoices')
  post(
    @Body(new ZodValidationPipe(createArInvoiceSchema)) dto: CreateArInvoiceDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.arInvoices.postArInvoice(dto, user.username);
  }

  @RequirePermissions('finance:ar_invoice:read')
  @Get('ar-invoices/open-items')
  openItems(@Query(new ZodValidationPipe(arOpenItemQuerySchema)) q: ArOpenItemQuery) {
    return this.arInvoices.listOpenItems(q);
  }
}
