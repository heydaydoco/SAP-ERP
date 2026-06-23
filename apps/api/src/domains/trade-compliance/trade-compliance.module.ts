import { Module } from '@nestjs/common';
import { NumberingModule } from '../platform/numbering/numbering.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import { MasterDataModule } from '../master-data/master-data.module.js';
import { ExportDeclarationController } from './export-declaration/export-declaration.controller.js';
import { ExportDeclarationService } from './export-declaration/export-declaration.service.js';
import { ImportDeclarationController } from './import-declaration/import-declaration.controller.js';
import { ImportDeclarationService } from './import-declaration/import-declaration.service.js';

/**
 * Trade & compliance domain module (SAP GTS) — Phase 7 `customs-declaration`: `export-declaration` (수출신고,
 * slice 1) + `import-declaration` (수입신고, slice 2). Both are non-posting customs documents, so NO
 * FinanceAccountingModule: it imports PlatformModule (DocFlowService — the `DECLARES` lineage onto the
 * 601 GI / 101 GR), NumberingModule (ED-/IM-NNNNNN), and MasterDataModule (BusinessPartnerService /
 * CurrencyService / DbCurrencyRegistry). Cross-domain reads (delivery / sales_order / billing for the
 * export 영세율 gate; goods_movement / plant for the import GR anchor) go through the injected `@Inject(DB)`
 * directly, READ-ONLY — no SalesModule / InventoryModule / landed-cost import.
 */
@Module({
  imports: [PlatformModule, NumberingModule, MasterDataModule],
  providers: [ExportDeclarationService, ImportDeclarationService],
  controllers: [ExportDeclarationController, ImportDeclarationController],
  exports: [ExportDeclarationService, ImportDeclarationService],
})
export class TradeComplianceModule {}
