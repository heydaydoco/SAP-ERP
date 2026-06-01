import { Injectable } from '@nestjs/common';
import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';

/** Action + subject ability. Subject is the `domain:subject` slice of a permission code. */
export type AppAbility = MongoAbility<[string, string]>;

/**
 * Builds a CASL ability from a user's permission codes (root CLAUDE.md §3.6, §4). Each
 * `domain:subject:action` becomes `can(action, "domain:subject")`; the wildcard `*` grants
 * `manage all` (superuser). Defined once — no string-literal permission checks scattered in code.
 */
@Injectable()
export class CaslAbilityFactory {
  createForUser(user: { permissions: string[] }): AppAbility {
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    for (const perm of user.permissions ?? []) {
      if (perm === '*') {
        can('manage', 'all');
        continue;
      }
      const [domain, subject, action] = perm.split(':');
      if (domain && subject && action) {
        can(action, `${domain}:${subject}`);
      }
    }
    return build();
  }
}

/** True iff the ability satisfies a `domain:subject:action` permission code. */
export function permissionMatches(ability: AppAbility, permission: string): boolean {
  const [domain, subject, action] = permission.split(':');
  if (!domain || !subject || !action) return false;
  return ability.can(action, `${domain}:${subject}`);
}
