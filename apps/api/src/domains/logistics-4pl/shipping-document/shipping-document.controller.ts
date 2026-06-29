import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { ShippingDocumentService } from './shipping-document.service.js';
import {
  addShippingDocumentSchema,
  createShippingDocumentSetSchema,
  shippingDocumentSetQuerySchema,
  type AddShippingDocumentDto,
  type CreateShippingDocumentSetDto,
  type ShippingDocumentSetQuery,
} from './shipping-document.dto.js';

@Controller('logistics-4pl')
export class ShippingDocumentController {
  constructor(private readonly shippingDocuments: ShippingDocumentService) {}

  @RequirePermissions('logistics_4pl:shipping_document:create')
  @Post('shipping-document-sets')
  create(
    @Body(new ZodValidationPipe(createShippingDocumentSetSchema)) dto: CreateShippingDocumentSetDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.shippingDocuments.create(dto, user.username);
  }

  /** Append ONE document line (B/L·CI·PL) to an existing set. */
  @RequirePermissions('logistics_4pl:shipping_document:create')
  @Post('shipping-document-sets/:id/documents')
  addDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(addShippingDocumentSchema)) dto: AddShippingDocumentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.shippingDocuments.addDocument(id, dto, user.username);
  }

  @RequirePermissions('logistics_4pl:shipping_document:read')
  @Get('shipping-document-sets')
  async list(
    @Query(new ZodValidationPipe(shippingDocumentSetQuerySchema)) q: ShippingDocumentSetQuery,
  ) {
    const [rows, total] = await Promise.all([
      this.shippingDocuments.listShippingDocumentSets(q, q.pageSize, toOffset(q)),
      this.shippingDocuments.countShippingDocumentSets(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('logistics_4pl:shipping_document:read')
  @Get('shipping-document-sets/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.shippingDocuments.getShippingDocumentSet(id);
  }
}
