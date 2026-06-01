import { describe, it, expect } from 'vitest';
import { CaslAbilityFactory, permissionMatches } from './casl-ability.factory';

const factory = new CaslAbilityFactory();

describe('CaslAbilityFactory', () => {
  it('grants exactly the listed domain:subject:action permissions', () => {
    const ability = factory.createForUser({ permissions: ['sales:sales_order:approve'] });
    expect(permissionMatches(ability, 'sales:sales_order:approve')).toBe(true);
    expect(permissionMatches(ability, 'sales:sales_order:delete')).toBe(false);
    expect(permissionMatches(ability, 'finance:journal:post')).toBe(false);
  });

  it('treats "*" as manage-all (superuser)', () => {
    const ability = factory.createForUser({ permissions: ['*'] });
    expect(permissionMatches(ability, 'finance:journal:post')).toBe(true);
    expect(permissionMatches(ability, 'hr_payroll:payroll_run:execute')).toBe(true);
  });

  it('grants nothing for an empty permission set', () => {
    const ability = factory.createForUser({ permissions: [] });
    expect(permissionMatches(ability, 'sales:sales_order:read')).toBe(false);
  });

  it('ignores malformed permission codes', () => {
    const ability = factory.createForUser({ permissions: ['bad', 'a:b'] });
    expect(permissionMatches(ability, 'a:b:c')).toBe(false);
  });
});
