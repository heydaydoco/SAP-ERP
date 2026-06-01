import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';

/**
 * RBAC queries + grant management (platform.rbac). `getUserGrants` resolves a user's role codes and
 * the union of their permission codes for token issuance; the `ensure*`/`grant*`/`assign*` helpers
 * are idempotent and used by the seed and (later) admin-config.
 */
@Injectable()
export class RbacService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async getUserGrants(userId: string): Promise<{ roles: string[]; permissions: string[] }> {
    const roleRows = await this.db
      .select({ id: schema.role.id, code: schema.role.code })
      .from(schema.userRole)
      .innerJoin(schema.role, eq(schema.userRole.roleId, schema.role.id))
      .where(eq(schema.userRole.userId, userId));

    if (roleRows.length === 0) return { roles: [], permissions: [] };

    const permRows = await this.db
      .select({ permission: schema.rolePermission.permission })
      .from(schema.rolePermission)
      .where(
        inArray(
          schema.rolePermission.roleId,
          roleRows.map((r) => r.id),
        ),
      );

    return {
      roles: roleRows.map((r) => r.code),
      permissions: [...new Set(permRows.map((p) => p.permission))],
    };
  }

  /** Create a role if absent; returns its id. */
  async ensureRole(code: string, name: string, description?: string): Promise<string> {
    await this.db
      .insert(schema.role)
      .values({ code, name, description: description ?? null, createdBy: 'system', updatedBy: 'system' })
      .onConflictDoNothing({ target: schema.role.code });
    const [row] = await this.db
      .select({ id: schema.role.id })
      .from(schema.role)
      .where(eq(schema.role.code, code));
    if (!row) throw new Error(`role ${code} missing after ensureRole`);
    return row.id;
  }

  async grantPermission(roleId: string, permission: string): Promise<void> {
    await this.db
      .insert(schema.rolePermission)
      .values({ roleId, permission, createdBy: 'system', updatedBy: 'system' })
      .onConflictDoNothing({
        target: [schema.rolePermission.roleId, schema.rolePermission.permission],
      });
  }

  async assignRole(userId: string, roleId: string): Promise<void> {
    await this.db
      .insert(schema.userRole)
      .values({ userId, roleId, createdBy: 'system', updatedBy: 'system' })
      .onConflictDoNothing({ target: [schema.userRole.userId, schema.userRole.roleId] });
  }
}
