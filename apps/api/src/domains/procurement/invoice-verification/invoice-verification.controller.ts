import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { InvoiceVerificationService } from './invoice-verification.service.js';
import {
  createInvoiceVerificationSchema,
  type CreateInvoiceVerificationDto,
} from './invoice-verification.dto.js';

@Controller('procurement')
export class InvoiceVerificationController {
  constructor(private readonly invoiceVerifications: InvoiceVerificationService) {}

  @RequirePermissions('procurement:invoice_verification:post')
  @Post('invoice-verifications')
  post(
    @Body(new ZodValidationPipe(createInvoiceVerificationSchema)) dto: CreateInvoiceVerificationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.invoiceVerifications.post(dto, user.username);
  }

  @RequirePermissions('procurement:invoice_verification:read')
  @Get('invoice-verifications/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.invoiceVerifications.getInvoiceVerification(id);
  }
}
