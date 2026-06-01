import { pgTable, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';
import { appUser } from './auth';

/**
 * RBAC (platform.rbac). Permissions are `domain:subject:action` strings (root CLAUDE.md §3.6),
 * granted to roles, which are assigned to users. The permission catalog/UI lives in admin-config
 * later; here we store granted permission codes directly on the role.
 */
export const role = pgTable('role', {
  id: pk(),
  code: varchar('code', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 128 }).notNull(),
  description: varchar('description', { length: 255 }),
  ...auditColumns(),
});

export const rolePermission = pgTable(
  'role_permission',
  {
    id: pk(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id),
    /** `domain:subject:action`, or `*` for superuser (manage all). */
    permission: varchar('permission', { length: 128 }).notNull(),
    ...auditColumns(),
  },
  (t) => [unique('role_permission_uq').on(t.roleId, t.permission)],
);

export const userRole = pgTable(
  'user_role',
  {
    id: pk(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => role.id),
    ...auditColumns(),
  },
  (t) => [unique('user_role_uq').on(t.userId, t.roleId)],
);
