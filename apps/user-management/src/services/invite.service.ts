import { createHash, randomBytes } from 'node:crypto';
import { inject } from 'inversify';
import { ErrUtils, RequestContext } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import { InviteStatus, Scope } from '@aegis/shared-enums';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { InviteRepository } from '../repositories/invite.repository';

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Invitation service. The raw token is returned once on create; only its hash is stored. */
@provideSingleton(InviteService)
export class InviteService {
  constructor(@inject(InviteRepository) private readonly invites: InviteRepository) {}

  async list(): Promise<{ data: UserManagementShape.InviteDto[] }> {
    return withTenantTransaction(async (t) => ({
      data: (await this.invites.list(t)).map((row) => this.toDto(row)),
    }));
  }

  async create(input: UserManagementShape.CreateInviteInput): Promise<UserManagementShape.InviteDto> {
    const token = randomBytes(32).toString('base64url');
    const tenantId = RequestContext.tenantId();
    const actorId = RequestContext.userId() ?? null;
    const expiresAt = input.expiresAt
      ? new Date(input.expiresAt)
      : new Date(Date.now() + DEFAULT_INVITE_TTL_MS);
    if (Number.isNaN(expiresAt.getTime())) throw ErrUtils.validation('Invalid invite expiry');

    return withTenantTransaction(async (t) =>
      this.toDto(
        await this.invites.create(
          {
            tenant_id: tenantId,
            email: input.email,
            token_hash: this.hashToken(token),
            status: InviteStatus.Pending,
            role_id: input.roleId ?? null,
            scope: input.scope ?? Scope.OwnOnly,
            team_ids: input.teamIds ?? [],
            expires_at: expiresAt,
            created_by: actorId,
          },
          t,
        ),
        token,
      ),
    );
  }

  async revoke(id: string): Promise<UserManagementShape.InviteDto> {
    return withTenantTransaction(async (t) => {
      const row = await this.invites.revoke(id, t);
      if (!row) throw ErrUtils.notFound('Invite not found');
      return this.toDto(row);
    });
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private toDto(row: UserManagementShape.InviteRow, token?: string): UserManagementShape.InviteDto {
    const dto: UserManagementShape.InviteDto = {
      id: row.id,
      email: row.email,
      status: row.status,
      roleId: row.role_id,
      scope: row.scope,
      teamIds: row.team_ids ?? [],
      expiresAt: new Date(row.expires_at).toISOString(),
    };
    if (token) dto.token = token;
    return dto;
  }
}
