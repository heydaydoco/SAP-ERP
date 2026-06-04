import { Module } from '@nestjs/common';
import { BusinessPartnerController } from './business-partner/business-partner.controller.js';
import { BusinessPartnerService } from './business-partner/business-partner.service.js';
import { CurrencyController } from './currency/currency.controller.js';
import { CurrencyService } from './currency/currency.service.js';
import { DbCurrencyRegistry } from './currency/db-currency-registry.js';
import { CostCenterController } from './cost-center/cost-center.controller.js';
import { CostCenterService } from './cost-center/cost-center.service.js';
import { GlAccountController } from './gl-account/gl-account.controller.js';
import { GlAccountService } from './gl-account/gl-account.service.js';
import { TaxCodeController } from './tax-code/tax-code.controller.js';
import { TaxCodeService } from './tax-code/tax-code.service.js';

/**
 * Master-data domain module (Phase 1). FI-foundation masters — currency/fx-rate, gl-account,
 * tax-code, cost-center (slice 1) — plus business-partner (slice 2; customer/vendor roles for
 * Phase 2 AR/AP). `DbCurrencyRegistry` feeds the kernel `Money` object exact minor units from the DB
 * (root CLAUDE.md §3.1). Services are exported so the seed can populate demo data. material is next.
 */
@Module({
  providers: [
    DbCurrencyRegistry,
    CurrencyService,
    GlAccountService,
    TaxCodeService,
    CostCenterService,
    BusinessPartnerService,
  ],
  controllers: [
    CurrencyController,
    GlAccountController,
    TaxCodeController,
    CostCenterController,
    BusinessPartnerController,
  ],
  exports: [
    DbCurrencyRegistry,
    CurrencyService,
    GlAccountService,
    TaxCodeService,
    CostCenterService,
    BusinessPartnerService,
  ],
})
export class MasterDataModule {}
