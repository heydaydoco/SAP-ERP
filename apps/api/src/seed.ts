import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { UsersService } from './domains/platform/auth/users.service.js';
import { RbacService } from './domains/platform/rbac/rbac.service.js';
import { NumberingService } from './domains/platform/numbering/numbering.service.js';
import { OrgStructureService } from './domains/platform/org-structure/org-structure.service.js';
import { FiscalPeriodService } from './domains/platform/admin-config/fiscal-period.service.js';
import { AccountDeterminationService } from './domains/platform/admin-config/account-determination.service.js';
import { CurrencyService } from './domains/master-data/currency/currency.service.js';
import { GlAccountService } from './domains/master-data/gl-account/gl-account.service.js';
import { TaxCodeService } from './domains/master-data/tax-code/tax-code.service.js';
import { CostCenterService } from './domains/master-data/cost-center/cost-center.service.js';
import { BusinessPartnerService } from './domains/master-data/business-partner/business-partner.service.js';

/**
 * Idempotent dev seed: creates an ADMIN role (permission `*`), an admin user, and a couple of demo
 * number ranges. Run after migrations:  pnpm --filter @erp/api seed
 * Configure via ADMIN_USERNAME / ADMIN_PASSWORD (defaults admin / admin123 — change in real envs).
 */
async function seed(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const users = app.get(UsersService);
    const rbac = app.get(RbacService);
    const numbering = app.get(NumberingService);
    const org = app.get(OrgStructureService);
    const fiscal = app.get(FiscalPeriodService);
    const accounts = app.get(AccountDeterminationService);
    const currencies = app.get(CurrencyService);
    const glAccounts = app.get(GlAccountService);
    const taxCodes = app.get(TaxCodeService);
    const costCenters = app.get(CostCenterService);
    const partners = app.get(BusinessPartnerService);

    const username = process.env.ADMIN_USERNAME ?? 'admin';
    const password = process.env.ADMIN_PASSWORD ?? 'admin123';

    const userId = await users.createUser({
      username,
      password,
      displayName: 'Administrator',
    });
    const roleId = await rbac.ensureRole('ADMIN', 'Administrator', 'Full system access');
    await rbac.grantPermission(roleId, '*');
    await rbac.assignRole(userId, roleId);

    await numbering.defineRange({
      object: 'sales.sales_order',
      prefix: 'SO-',
      padding: 6,
    });
    await numbering.defineRange({
      object: 'procurement.purchase_order',
      prefix: 'PO-',
      padding: 6,
    });

    // Demo enterprise structure: company 1000 (KRW) → plant 1010 → storage location 101A,
    // plus a sales + purchasing org. Idempotent, so the seed stays re-runnable.
    const companyCodeId = await org.ensureCompanyCode({
      code: '1000',
      name: 'Heyday Trading Co., Ltd.',
      currency: 'KRW',
      country: 'KR',
      chartOfAccounts: 'KR01',
    });
    const plantId = await org.ensurePlant({
      code: '1010',
      name: 'Seoul Main Plant',
      companyCodeId,
      country: 'KR',
      city: 'Seoul',
    });
    await org.ensureStorageLocation({
      code: '101A',
      name: 'Main Warehouse',
      plantId,
    });
    await org.ensureSalesOrg({
      code: '1000',
      name: 'Domestic Sales',
      companyCodeId,
      currency: 'KRW',
    });
    await org.ensurePurchasingOrg({
      code: '1000',
      name: 'Central Purchasing',
      companyCodeId,
    });

    // Admin-config: fiscal year 2026 (12 OPEN periods) + account-determination rules for the
    // SD-billing posting (AR / sales revenue / output VAT). Idempotent.
    await fiscal.generateYear(companyCodeId, 2026);
    for (const rule of [
      { transactionKey: 'AR', glAccount: '1100' }, // 외상매출금
      { transactionKey: 'SALES_REVENUE', glAccount: '4000' }, // 제품매출
      { transactionKey: 'OUTPUT_VAT', glAccount: '2550' }, // 부가세예수금
    ]) {
      await accounts.defineRule({ chartOfAccounts: 'KR01', ...rule });
    }

    // Master data: currencies (with exact minor units), demo fx rates, the KR01 GL accounts the
    // determination rules above resolve to, VAT codes, and a cost center. Idempotent.
    for (const cur of [
      { code: 'KRW', name: 'South Korean Won', minorUnit: 0, symbol: '₩' },
      { code: 'USD', name: 'US Dollar', minorUnit: 2, symbol: '$' },
      { code: 'EUR', name: 'Euro', minorUnit: 2, symbol: '€' },
      { code: 'CNY', name: 'Chinese Yuan', minorUnit: 2, symbol: '¥' },
      { code: 'JPY', name: 'Japanese Yen', minorUnit: 0, symbol: '¥' },
    ]) {
      await currencies.ensureCurrency(cur);
    }
    for (const fx of [
      { fromCurrency: 'USD', toCurrency: 'KRW', rate: '1350.000000' },
      { fromCurrency: 'EUR', toCurrency: 'KRW', rate: '1450.000000' },
    ]) {
      await currencies.ensureFxRate({ rateType: 'M', validFrom: '2026-01-01', ...fx });
    }
    for (const acc of [
      { accountNumber: '1000', name: '현금및현금성자산', accountType: 'ASSET' as const },
      {
        accountNumber: '1100',
        name: '외상매출금',
        accountType: 'ASSET' as const,
        isReconciliation: true,
      },
      {
        accountNumber: '2100',
        name: '외상매입금',
        accountType: 'LIABILITY' as const,
        isReconciliation: true,
      },
      { accountNumber: '2550', name: '부가세예수금', accountType: 'LIABILITY' as const },
      { accountNumber: '4000', name: '제품매출', accountType: 'REVENUE' as const },
    ]) {
      await glAccounts.ensureGlAccount({
        chartOfAccounts: 'KR01',
        isReconciliation: false,
        ...acc,
      });
    }
    for (const tax of [
      {
        code: 'V10',
        name: '매출 부가세 10%',
        kind: 'OUTPUT' as const,
        ratePercent: '10',
        glAccount: '2550',
      },
      { code: 'A10', name: '매입 부가세 10%', kind: 'INPUT' as const, ratePercent: '10' },
    ]) {
      await taxCodes.ensureTaxCode(tax);
    }
    await costCenters.ensureCostCenter({
      code: '1000',
      name: 'Administration',
      companyCodeId,
      validFrom: '2026-01-01',
    });

    // Business partners: a customer (AR recon 1100) and a vendor (AP recon 2100). Idempotent.
    const customerBpId = await partners.ensureBp({
      code: 'C1000',
      name: 'Acme Retail Co., Ltd.',
      bpType: 'ORGANIZATION',
      country: 'KR',
      city: 'Seoul',
    });
    await partners.ensureCustomerRole(customerBpId, {
      arReconAccount: '1100',
      creditLimit: '50000000.0000',
      creditCurrency: 'KRW',
      paymentTermsDays: 30,
      salesBlock: false,
    });
    const vendorBpId = await partners.ensureBp({
      code: 'V2000',
      name: 'Shenzhen Components Ltd.',
      bpType: 'ORGANIZATION',
      country: 'CN',
      city: 'Shenzhen',
    });
    await partners.ensureVendorRole(vendorBpId, {
      apReconAccount: '2100',
      paymentTermsDays: 45,
      purchasingBlock: false,
    });

    console.warn(
      `[seed] admin user '${username}' ready with ADMIN role (*) + demo number ranges + ` +
        `enterprise structure (company 1000 / plant 1010 / sloc 101A) + ` +
        `fiscal year 2026 (12 open periods) + KR01 account determination + ` +
        `master data (5 currencies / 2 fx rates / 5 GL accounts / 2 tax codes / cost center 1000 / ` +
        `2 business partners: customer C1000 + vendor V2000)`,
    );
  } finally {
    await app.close();
  }
}

void seed();
