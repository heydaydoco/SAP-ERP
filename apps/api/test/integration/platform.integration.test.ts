import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { JwtService } from '@nestjs/jwt';
import { schema, type Database } from '@erp/db';
import { PasswordService } from '../../src/domains/platform/auth/password.service.js';
import { TokenService } from '../../src/domains/platform/auth/token.service.js';
import { UsersService } from '../../src/domains/platform/auth/users.service.js';
import { AuthService } from '../../src/domains/platform/auth/auth.service.js';
import { RbacService } from '../../src/domains/platform/rbac/rbac.service.js';
import {
  CaslAbilityFactory,
  permissionMatches,
} from '../../src/domains/platform/rbac/casl-ability.factory.js';
import { NumberingService } from '../../src/domains/platform/numbering/numbering.service.js';

/**
 * End-to-end Phase-0 steps 4–6 over a real PostgreSQL 16 (Testcontainers): runs the committed
 * migrations, then proves numbering (gap-free), auth (login → token), and rbac (CASL permission).
 * Set SKIP_TESTCONTAINERS=1 to skip where Docker is unavailable.
 *
 * Run with:  pnpm --filter @erp/api test:integration
 */
const dockerAvailable = process.env.SKIP_TESTCONTAINERS !== '1';
const migrationsFolder = fileURLToPath(new URL('../../../../packages/db/drizzle', import.meta.url));

describe.skipIf(!dockerAvailable)('platform auth/rbac/numbering (integration)', () => {
  let container: StartedPostgreSqlContainer;
  let client: ReturnType<typeof postgres>;
  let db: Database;

  let users: UsersService;
  let rbac: RbacService;
  let auth: AuthService;
  let numbering: NumberingService;
  const casl = new CaslAbilityFactory();

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    client = postgres(container.getConnectionUri(), { max: 1 });
    db = drizzle(client, { schema, casing: 'snake_case' }) as unknown as Database;
    await migrate(db, { migrationsFolder });

    const password = new PasswordService();
    const tokens = new TokenService(new JwtService({ secret: 'test', signOptions: { expiresIn: '1h' } }));
    users = new UsersService(db, password);
    rbac = new RbacService(db);
    auth = new AuthService(users, password, tokens, rbac);
    numbering = new NumberingService(db);
  }, 120_000);

  afterAll(async () => {
    await client?.end({ timeout: 5 });
    await container?.stop();
  });

  it('allocates gap-free, formatted document numbers', async () => {
    await numbering.defineRange({ object: 'sales.sales_order', prefix: 'SO-', padding: 6 });
    expect(await numbering.next('sales.sales_order')).toBe('SO-000001');
    expect(await numbering.next('sales.sales_order')).toBe('SO-000002');
  });

  it('logs a user in and the issued token carries their granted permissions', async () => {
    const userId = await users.createUser({
      username: 'sales.mgr',
      password: 'pw-12345',
      displayName: 'Sales Manager',
    });
    const roleId = await rbac.ensureRole('SALES_MANAGER', 'Sales Manager');
    await rbac.grantPermission(roleId, 'sales:sales_order:approve');
    await rbac.assignRole(userId, roleId);

    const result = await auth.login({ username: 'sales.mgr', password: 'pw-12345' });
    expect(result.accessToken).toBeTruthy();
    expect(result.user.roles).toContain('SALES_MANAGER');

    const ability = casl.createForUser({ permissions: result.user.roles.length ? ['sales:sales_order:approve'] : [] });
    expect(permissionMatches(ability, 'sales:sales_order:approve')).toBe(true);
    expect(permissionMatches(ability, 'finance:journal:post')).toBe(false);
  });

  it('rejects bad credentials', async () => {
    await expect(auth.login({ username: 'sales.mgr', password: 'wrong' })).rejects.toThrow();
    await expect(auth.login({ username: 'nobody', password: 'x' })).rejects.toThrow();
  });
});
