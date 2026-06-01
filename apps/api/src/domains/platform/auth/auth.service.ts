import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RbacService } from '../rbac/rbac.service.js';
import type { AuthUser } from './auth.types.js';
import type { LoginDto, RefreshDto } from './auth.dto.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import { UsersService, type AppUser } from './users.service.js';

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; username: string; displayName: string; roles: string[] };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly password: PasswordService,
    private readonly tokens: TokenService,
    private readonly rbac: RbacService,
  ) {}

  async login(dto: LoginDto): Promise<AuthResult> {
    const user = await this.users.findByUsername(dto.username);
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('invalid credentials');
    if (!(await this.password.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('invalid credentials');
    }
    return this.issue(user);
  }

  async refresh(dto: RefreshDto): Promise<AuthResult> {
    let payload: { sub: string };
    try {
      payload = await this.tokens.verifyRefresh(dto.refreshToken);
    } catch {
      throw new UnauthorizedException('invalid refresh token');
    }
    const user = await this.users.findById(payload.sub);
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('account unavailable');
    return this.issue(user);
  }

  /** Re-reads grants from the DB on every issue, so role changes take effect on next login/refresh. */
  private async issue(user: AppUser): Promise<AuthResult> {
    const { roles, permissions } = await this.rbac.getUserGrants(user.id);
    const authUser: AuthUser = { sub: user.id, username: user.username, roles, permissions };
    return {
      accessToken: await this.tokens.signAccess(authUser),
      refreshToken: await this.tokens.signRefresh(authUser),
      user: { id: user.id, username: user.username, displayName: user.displayName, roles },
    };
  }
}
