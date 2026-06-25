import { Module } from '@nestjs/common';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { ShipmentController } from './shipment/shipment.controller.js';
import { ShipmentService } from './shipment/shipment.service.js';

/**
 * Logistics-4PL domain module (SAP TM/forwarding) — Phase 8 `shipment` (선적), the domain's first slice and
 * backbone document. A shipment is NON-POSTING (a physical transport unit; freight accounting is a later
 * logistics_charge slice), so it needs only PlatformModule (`DocFlowService` — the CONTAINS edges onto each
 * delivery) and NumberingModule (`NumberingService` — the SH- range). It imports NEITHER FinanceAccountingModule
 * nor AdminConfigModule (no FI). Cross-domain reads (delivery / sales_order for the physical anchor + company
 * check) go through `@Inject(DB)` directly, READ-ONLY.
 */
@Module({
  imports: [PlatformModule, NumberingModule],
  providers: [ShipmentService],
  controllers: [ShipmentController],
  exports: [ShipmentService],
})
export class Logistics4plModule {}
