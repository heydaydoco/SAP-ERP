import { Module } from '@nestjs/common';
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
 * Master-data domain module (Phase 1). Ships the FI-foundation masters — currency/fx-rate,
 * gl-account, tax-code, cost-center — that finance-accounting (Phase 2) sits on. `DbCurrencyRegistry`
 * feeds the kernel `Money` object exact minor units from the DB (root CLAUDE.md §3.1). Services are
 * exported so the seed can populate demo data. material + business-partner land in the next PR.
 */
@Module({
  providers: [
    DbCurrencyRegistry,
    CurrencyService,
    GlAccountService,
    TaxCodeService,
    CostCenterService,
  ],
  controllers: [CurrencyController, GlAccountController, TaxCodeController, CostCenterController],
  exports: [
    DbCurrencyRegistry,
    CurrencyService,
    GlAccountService,
    TaxCodeService,
    CostCenterService,
  ],
})
export class MasterDataModule {}
