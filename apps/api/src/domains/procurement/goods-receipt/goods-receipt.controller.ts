import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { GoodsReceiptService } from './goods-receipt.service.js';
import { createGoodsReceiptSchema, type CreateGoodsReceiptDto } from './goods-receipt.dto.js';

@Controller('procurement')
export class GoodsReceiptController {
  constructor(private readonly goodsReceipts: GoodsReceiptService) {}

  @RequirePermissions('procurement:goods_receipt:post')
  @Post('goods-receipts')
  post(
    @Body(new ZodValidationPipe(createGoodsReceiptSchema)) dto: CreateGoodsReceiptDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.goodsReceipts.post(dto, user.username);
  }

  @RequirePermissions('procurement:goods_receipt:read')
  @Get('purchase-orders/:id/goods-receipts')
  listForPo(@Param('id', ParseUUIDPipe) id: string) {
    return this.goodsReceipts.listForPurchaseOrder(id);
  }
}
