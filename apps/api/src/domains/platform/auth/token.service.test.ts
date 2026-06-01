import { describe, it, expect } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';
import type { AuthUser } from './auth.types';

const jwt = new JwtService({ secret: 'test-secret', signOptions: { expiresIn: '1h' } });
const tokens = new TokenService(jwt);

const user: AuthUser = {
  sub: 'u1',
  username: 'alice',
  roles: ['ADMIN'],
  permissions: ['*'],
};

describe('TokenService', () => {
  it('round-trips an access token with grants', async () => {
    const token = await tokens.signAccess(user);
    const decoded = await tokens.verifyAccess(token);
    expect(decoded.sub).toBe('u1');
    expect(decoded.username).toBe('alice');
    expect(decoded.permissions).toEqual(['*']);
  });

  it('rejects a refresh token used as an access token (and vice versa)', async () => {
    const refresh = await tokens.signRefresh(user);
    await expect(tokens.verifyAccess(refresh)).rejects.toThrow();

    const access = await tokens.signAccess(user);
    await expect(tokens.verifyRefresh(access)).rejects.toThrow();
  });

  it('verifies a refresh token', async () => {
    const refresh = await tokens.signRefresh(user);
    const decoded = await tokens.verifyRefresh(refresh);
    expect(decoded.sub).toBe('u1');
  });
});
