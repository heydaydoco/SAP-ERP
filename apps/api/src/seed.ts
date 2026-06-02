import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { UsersService } from './domains/platform/auth/users.service.js';
import { RbacService } from './domains/platform/rbac/rbac.service.js';
import { NumberingService } from './domains/platform/numbering/numbering.service.js';
import { OrgStructureService } from './domains/platform/org-structure/org-structure.service.js';

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

    console.warn(
      `[seed] admin user '${username}' ready with ADMIN role (*) + demo number ranges + ` +
        `enterprise structure (company 1000 / plant 1010 / sloc 101A)`,
    );
  } finally {
    await app.close();
  }
}

void seed();
