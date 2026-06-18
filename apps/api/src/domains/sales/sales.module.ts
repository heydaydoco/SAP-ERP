import { Module } from '@nestjs/common';
import { AdminConfigModule } from '../platform/admin-config/admin-config.module.js';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { FinanceAccountingModule } from '../finance-accounting/finance-accounting.module.js';
import { InventoryWarehouseModule } from '../inventory-warehouse/inventory-warehouse.module.js';
import { SalesQueryService } from './sales-query.service.js';
import { SalesOrderController } from './sales-order/sales-order.controller.js';
import { SalesOrderService } from './sales-order/sales-order.service.js';
import { DeliveryController } from './delivery/delivery.controller.js';
import { DeliveryService } from './delivery/delivery.service.js';
import { BillingController } from './billing/billing.controller.js';
import { BillingService } from './billing/billing.service.js';

/**
 * Sales domain module (Phase 3 slice 5: O2C SO→Delivery/GI→Billing). The MIRROR of procurement's P2P:
 * the delivery REUSES the inventory goods-movement engine (imported `GoodsMovementService`) with a COGS
 * offset and SO lineage (601 GI); billing posts the AR open item through the imported `JournalService`
 * and reuses the AR recon substitution + tax-line builder (FinanceAccountingModule / MasterDataModule).
 * COGS resolves via account_determination (§4.5).
 */
@Module({
  imports: [
    PlatformModule,
    NumberingModule,
    AdminConfigModule,
    MasterDataModule,
    FinanceAccountingModule,
    InventoryWarehouseModule,
  ],
  providers: [SalesQueryService, SalesOrderService, DeliveryService, BillingService],
  controllers: [SalesOrderController, DeliveryController, BillingController],
  exports: [SalesQueryService, SalesOrderService, DeliveryService, BillingService],
})
export class SalesModule {}
