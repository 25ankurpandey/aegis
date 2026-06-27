import { inject } from 'inversify';
import { ErrUtils } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { SessionRepository } from '../repositories/session.repository';

/** Session admin service for listing and revoking reference-IdP sessions. */
@provideSingleton(SessionService)
export class SessionService {
  constructor(@inject(SessionRepository) private readonly sessions: SessionRepository) {}

  async list(): Promise<{ data: UserManagementShape.SessionDto[] }> {
    return withTenantTransaction(async (t) => ({
      data: (await this.sessions.list(t)).map((row) => this.toDto(row)),
    }));
  }

  async revoke(id: string): Promise<UserManagementShape.SessionDto> {
    return withTenantTransaction(async (t) => {
      const row = await this.sessions.revoke(id, t);
      if (!row) throw ErrUtils.notFound('Session not found');
      return this.toDto(row);
    });
  }

  private toDto(row: UserManagementShape.SessionRow): UserManagementShape.SessionDto {
    return {
      id: row.id,
      userId: row.user_id,
      jti: row.jti,
      status: row.status,
      expiresAt: new Date(row.expires_at).toISOString(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
    };
  }
}
