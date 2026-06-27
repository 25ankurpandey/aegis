import { inject } from 'inversify';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Config, ErrUtils, RequestContext } from '@aegis/service-core';
import { AuthConstants } from '@aegis/shared-constants';
import { AuditAction, AuditOutcome, SessionStatus } from '@aegis/shared-enums';
import { UserManagementShape } from '@aegis/shared-types';
import { withTenantTransaction } from '@aegis/db';
import { AuditLogger } from '@aegis/audit';
import { provideSingleton } from '../ioc/container';
import { UserRepository } from '../repositories/user.repository';
import { SessionRepository } from '../repositories/session.repository';
import { hashPassword, verifyPassword } from '../utils/password';

/** The reference IdP: register, login (issues a permission-bearing JWT), and `me`. */
@provideSingleton(AuthService)
export class AuthService {
  constructor(
    @inject(UserRepository) private readonly users: UserRepository,
    @inject(SessionRepository) private readonly sessions: SessionRepository,
  ) {}

  async register(input: UserManagementShape.RegisterInput): Promise<UserManagementShape.RegisterResult> {
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      if (await this.users.findByEmail(input.email, t)) {
        throw ErrUtils.validation('Email already registered');
      }
      const user = await this.users.create(
        {
          tenant_id: tenantId,
          email: input.email,
          password_hash: hashPassword(input.password),
          first_name: input.firstName,
          last_name: input.lastName,
        },
        t,
      );
      return { id: user.id, email: user.email };
    });
  }

  async login(input: UserManagementShape.LoginInput): Promise<UserManagementShape.LoginResult> {
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      const user = await this.users.findByEmail(input.email, t);
      if (!user || !verifyPassword(input.password, user.password_hash)) {
        throw ErrUtils.unauthorized('Invalid credentials');
      }
      const access = await this.users.getAccess(user.id, t);
      const ttl = Config.int('TOKEN_TTL_SECONDS', AuthConstants.DefaultTokenTtlSeconds);
      const jti = randomUUID();
      const expiresAt = new Date(Date.now() + ttl * 1000);
      const claims: UserManagementShape.JwtClaims = {
        sub: user.id,
        tenant_id: tenantId,
        roles: access.roles,
        permissions: access.permissions,
        scope: access.scope,
        aud: 'aegis',
      };
      const session = await this.sessions.create(
        {
          tenant_id: tenantId,
          user_id: user.id,
          jti,
          status: SessionStatus.Active,
          expires_at: expiresAt,
        },
        t,
      );
      const token = jwt.sign(claims, Config.require('AUTH_JWT_SECRET'), { expiresIn: ttl, jwtid: jti });
      await AuditLogger.record(
        {
          action: AuditAction.LoginSucceeded,
          outcome: AuditOutcome.Success,
          actorId: user.id,
          resourceType: 'user',
          resourceId: user.id,
          permissions: access.permissions,
        },
        t,
      );
      return {
        token,
        expiresIn: ttl,
        sessionId: session.id,
        user: { id: user.id, email: user.email, roles: access.roles },
      };
    });
  }

  async me(): Promise<UserManagementShape.MeResult> {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');
    return withTenantTransaction(async (t) => {
      const user = await this.users.findById(userId, t);
      if (!user) throw ErrUtils.notFound('User not found');
      const access = await this.users.getAccess(userId, t);
      return { id: user.id, email: user.email, ...access };
    });
  }
}
