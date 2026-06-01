import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { UsersService } from './domains/platform/auth/users.service.js';
import { RbacService } from './domains/platform/rbac/rbac.service.js';
import { NumberingService } from './domains/platform/numbering/numbering.service.js';

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

    const username = process.env.ADMIN_USERNAME ?? 'admin';
    const password = process.env.ADMIN_PASSWORD ?? 'admin123';

    const userId = await users.createUser({ username, password, displayName: 'Administrator' });
    const roleId = await rbac.ensureRole('ADMIN', 'Administrator', 'Full system access');
    await rbac.grantPermission(roleId, '*');
    await rbac.assignRole(userId, roleId);

    await numbering.defineRange({ object: 'sales.sales_order', prefix: 'SO-', padding: 6 });
    await numbering.defineRange({ object: 'procurement.purchase_order', prefix: 'PO-', padding: 6 });

    console.warn(`[seed] admin user '${username}' ready with ADMIN role (*) + demo number ranges`);
  } finally {
    await app.close();
  }
}

void seed();
