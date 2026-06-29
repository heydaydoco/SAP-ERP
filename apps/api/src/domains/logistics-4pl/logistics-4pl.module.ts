import { Module } from '@nestjs/common';
import { AdminConfigModule } from '../platform/admin-config/admin-config.module.js';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { FinanceAccountingModule } from '../finance-accounting/finance-accounting.module.js';
import { ShipmentController } from './shipment/shipment.controller.js';
import { ShipmentService } from './shipment/shipment.service.js';
import { FreightSettlementController } from './freight-settlement/freight-settlement.controller.js';
import { FreightSettlementService } from './freight-settlement/freight-settlement.service.js';
import { ShippingDocumentController } from './shipping-document/shipping-document.controller.js';
import { ShippingDocumentService } from './shipping-document/shipping-document.service.js';
import { TrackingEventController } from './tracking-event/tracking-event.controller.js';
import { TrackingEventService } from './tracking-event/tracking-event.service.js';
import { CarrierBookingController } from './carrier-booking/carrier-booking.controller.js';
import { CarrierBookingService } from './carrier-booking/carrier-booking.service.js';

/**
 * Logistics-4PL domain module (SAP TM/forwarding). `shipment` (선적) is the non-posting backbone (Phase 8 slice
 * 1); `freight-settlement` (운임 정산) is the domain's FIRST FI document — it posts a `KR` journal (the journal IS
 * the AP document, like landed-cost), so on top of the shipment's PlatformModule (`DocFlowService`) +
 * NumberingModule it adds FinanceAccountingModule (`JournalService`), AdminConfigModule
 * (`AccountDeterminationService` — the FREIGHT key) and MasterDataModule (`BusinessPartnerService` recon
 * substitution + `CurrencyService`/`DbCurrencyRegistry` for the document-rate stamp). `shipping-document`
 * (선적 서류세트 — B/L·CI·PL) is NON-POSTING like the shipment, so it needs only PlatformModule (`DocFlowService`)
 * + NumberingModule (no Finance/AdminConfig/MasterData). `tracking-event` (화물추적) is leaner still — a
 * header-less, non-posting observation log keyed by `shipment_id`, with NO doc_flow edge and NO numbering, so
 * it needs only `@Inject(DB)`. `carrier-booking` (운송수배) is NON-POSTING too — it registers a carrier reservation
 * (number + cut-offs) against a shipment, so it needs PlatformModule (`DocFlowService`) + NumberingModule +
 * MasterDataModule (`BusinessPartnerService`, to verify the carrier BP role — NO recon, non-posting). Cross-domain
 * reads (the shipment, for existence + company check) go through `@Inject(DB)` directly, READ-ONLY.
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
    ShipmentService,
    FreightSettlementService,
    ShippingDocumentService,
    TrackingEventService,
    CarrierBookingService,
  ],
  controllers: [
    ShipmentController,
    FreightSettlementController,
    ShippingDocumentController,
    TrackingEventController,
    CarrierBookingController,
  ],
  exports: [
    ShipmentService,
    FreightSettlementService,
    ShippingDocumentService,
    TrackingEventService,
    CarrierBookingService,
  ],
})
export class Logistics4plModule {}
