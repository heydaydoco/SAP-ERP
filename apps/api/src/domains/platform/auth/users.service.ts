import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@erp/db';
import { DB } from '../../../database/database.module.js';
import { PasswordService } from './password.service.js';

export type AppUser = typeof schema.appUser.$inferSelect;

export interface CreateUserInput {
  username: string;
  password: string;
  displayName: string;
  email?: string;
}

/** App-user lookups + creation (platform.auth). Stores only the password hash. */
@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly password: PasswordService,
  ) {}

  async findByUsername(username: string): Promise<AppUser | undefined> {
    const [user] = await this.db
      .select()
      .from(schema.appUser)
      .where(eq(schema.appUser.username, username));
    return user;
  }

  async findById(id: string): Promise<AppUser | undefined> {
    const [user] = await this.db.select().from(schema.appUser).where(eq(schema.appUser.id, id));
    return user;
  }

  /** Create a user if absent (idempotent on username); returns the id. */
  async createUser(input: CreateUserInput): Promise<string> {
    const passwordHash = await this.password.hash(input.password);
    const [created] = await this.db
      .insert(schema.appUser)
      .values({
        username: input.username,
        email: input.email ?? null,
        passwordHash,
        displayName: input.displayName,
        createdBy: 'system',
        updatedBy: 'system',
      })
      .onConflictDoNothing({ target: schema.appUser.username })
      .returning({ id: schema.appUser.id });

    if (created) return created.id;
    const existing = await this.findByUsername(input.username);
    if (!existing) throw new Error(`failed to create or find user ${input.username}`);
    return existing.id;
  }
}
