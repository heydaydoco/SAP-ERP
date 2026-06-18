import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { paginated, toOffset } from '../../../common/index.js';
import { ZodValidationPipe } from '../../../common/zod-validation.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import type { AuthUser } from '../../platform/auth/auth.types.js';
import { RequirePermissions } from '../../platform/rbac/permissions.decorator.js';
import { SalesQueryService } from '../sales-query.service.js';
import { SalesOrderService } from './sales-order.service.js';
import {
  createSalesOrderSchema,
  salesOrderQuerySchema,
  type CreateSalesOrderDto,
  type SalesOrderQuery,
} from './sales-order.dto.js';

@Controller('sales')
export class SalesOrderController {
  constructor(
    private readonly salesOrders: SalesOrderService,
    private readonly query: SalesQueryService,
  ) {}

  @RequirePermissions('sales:sales_order:create')
  @Post('sales-orders')
  create(
    @Body(new ZodValidationPipe(createSalesOrderSchema)) dto: CreateSalesOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.salesOrders.create(dto, user.username);
  }

  @RequirePermissions('sales:sales_order:read')
  @Get('sales-orders')
  async list(@Query(new ZodValidationPipe(salesOrderQuerySchema)) q: SalesOrderQuery) {
    const [rows, total] = await Promise.all([
      this.salesOrders.listSalesOrders(q, q.pageSize, toOffset(q)),
      this.salesOrders.countSalesOrders(q),
    ]);
    return paginated(rows, total, q);
  }

  @RequirePermissions('sales:sales_order:read')
  @Get('sales-orders/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.salesOrders.getSalesOrder(id);
  }

  /** O2C status per SO item: ordered / delivered / billed + open-to-deliver / open-to-bill. */
  @RequirePermissions('sales:sales_order:read')
  @Get('sales-orders/:id/o2c')
  o2c(@Param('id', ParseUUIDPipe) id: string) {
    return this.query.o2cBySalesOrder(id);
  }
}
