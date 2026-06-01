import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import type { AuthUser } from './auth.types.js';

const REFRESH_TYP = 'refresh';

interface RefreshPayload {
  sub: string;
  username: string;
}

/** Issues/verifies JWT access + refresh tokens. Access carries the full grant set (roles/perms). */
@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  signAccess(user: AuthUser): Promise<string> {
    return this.jwt.signAsync({ ...user });
  }

  signRefresh(user: AuthUser): Promise<string> {
    return this.jwt.signAsync(
      { sub: user.sub, username: user.username, typ: REFRESH_TYP },
      // jsonwebtoken's expiresIn type rejects a widened `string`; narrow it.
      { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN ?? '7d') as JwtSignOptions['expiresIn'] },
    );
  }

  async verifyAccess(token: string): Promise<AuthUser> {
    const p = await this.jwt.verifyAsync<AuthUser & { typ?: string }>(token);
    if (p.typ === REFRESH_TYP) throw new UnauthorizedException('refresh token used as access');
    return { sub: p.sub, username: p.username, roles: p.roles ?? [], permissions: p.permissions ?? [] };
  }

  async verifyRefresh(token: string): Promise<RefreshPayload> {
    const p = await this.jwt.verifyAsync<RefreshPayload & { typ?: string }>(token);
    if (p.typ !== REFRESH_TYP) throw new UnauthorizedException('not a refresh token');
    return { sub: p.sub, username: p.username };
  }
}
