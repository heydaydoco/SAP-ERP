import { pgEnum, pgTable, varchar } from 'drizzle-orm/pg-core';
import { auditColumns, pk } from '../_shared/columns';

/**
 * Application user / login account (platform.auth). Distinct from the HR employee master
 * (Phase 9); an `employee_id` link is added when hr-payroll lands. Only the password **hash** is
 * stored — never the password (root CLAUDE.md §5.3).
 */
export const userStatus = pgEnum('user_status', ['ACTIVE', 'LOCKED', 'DISABLED']);

export const appUser = pgTable('app_user', {
  id: pk(),
  username: varchar('username', { length: 64 }).notNull().unique(),
  email: varchar('email', { length: 255 }),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 128 }).notNull(),
  status: userStatus('status').notNull().default('ACTIVE'),
  ...auditColumns(),
});
