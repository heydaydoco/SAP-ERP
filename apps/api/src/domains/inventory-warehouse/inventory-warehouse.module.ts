import { Module } from '@nestjs/common';
import { AdminConfigModule } from '../platform/admin-config/admin-config.module.js';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { FinanceAccountingModule } from '../finance-accounting/finance-accounting.module.js';
import { GoodsMovementController } from './goods-movement/goods-movement.controller.js';
import { GoodsMovementService } from './goods-movement/goods-movement.service.js';
import { MaterialValuationController } from './inventory/material-valuation.controller.js';
import { MaterialValuationService } from './inventory/material-valuation.service.js';
import { InventoryReconciliationService } from './inventory/reconciliation.service.js';
import { PhysicalInventoryController } from './physical-inventory/physical-inventory.controller.js';
import { PhysicalInventoryService } from './physical-inventory/physical-inventory.service.js';

/**
 * Inventory & Warehouse domain module (Phase 3 slice 1: MAP valuation + goods movements).
 * Goods movements are the SINGLE source of stock changes → FI: the movement service updates
 * stock + valuation and posts the journal through the imported `JournalService` in ONE
 * transaction (`PostOptions.tx` — §5.2). GL accounts resolve via account_determination
 * (BSX/GBB by valuation class, §4.5).
 */
@Module({
  imports: [
    PlatformModule,
    NumberingModule,
    AdminConfigModule,
    MasterDataModule,
    FinanceAccountingModule,
  ],
  providers: [
    GoodsMovementService,
    MaterialValuationService,
    InventoryReconciliationService,
    PhysicalInventoryService,
  ],
  controllers: [
    GoodsMovementController,
    MaterialValuationController,
    PhysicalInventoryController,
  ],
  exports: [
    GoodsMovementService,
    MaterialValuationService,
    InventoryReconciliationService,
    PhysicalInventoryService,
  ],
})
export class InventoryWarehouseModule {}
