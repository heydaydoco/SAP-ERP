import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { ProcurementQueryService } from '../procurement-query.service.js';
import { PurchaseOrderService } from './purchase-order.service.js';
import {
  createPurchaseOrderSchema,
  purchaseOrderQuerySchema,
  type CreatePurchaseOrderDto,
  type PurchaseOrderQuery,
} from './purchase-order.dto.js';

@Controller('procurement')
export class PurchaseOrderController {
  constructor(
    private readonly purchaseOrders: PurchaseOrderService,
    private readonly query: ProcurementQueryService,
  ) {}

  @RequirePermissions('procurement:purchase_order:create')
  @Post('purchase-orders')
  create(
    @Body(new ZodValidationPipe(createPurchaseOrderSchema)) dto: CreatePurchaseOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.purchaseOrders.create(dto, user.username);
  }

  @RequirePermissions('procurement:purchase_order:read')
  @Get('purchase-orders')
  async list(@Query(new ZodValidationPipe(purchaseOrderQuerySchema)) q: PurchaseOrderQuery) {
    const [rows, total] = await Promise.all([
      this.purchaseOrders.listPurchaseOrders(q, q.pageSize, toOffset(q)),
      this.purchaseOrders.countPurchaseOrders(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('procurement:purchase_order:read')
  @Get('purchase-orders/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.purchaseOrders.getPurchaseOrder(id);
  }

  /** GR/IR (입고미착) status per PO item: ordered / received / invoiced / open + open WRX value. */
  @RequirePermissions('procurement:purchase_order:read')
  @Get('purchase-orders/:id/gr-ir')
  grIr(@Param('id', ParseUUIDPipe) id: string) {
    return this.query.grIrByPurchaseOrder(id);
  }
}
