import { InviteStatus, Scope, SessionStatus, TenantStatus, UserStatus } from '@aegis/shared-enums';

const tx = { tx: true };
const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));

jest.mock('@aegis/db', () => ({
  withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])),
}));

import { RequestContext } from '@aegis/service-core';
import { InviteService } from '../../src/services/invite.service';
import { PolicyService } from '../../src/services/policy.service';
import { SessionService } from '../../src/services/session.service';
import { TenantService } from '../../src/services/tenant.service';

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 'tenant-1', userId: 'actor-1', correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

describe('user-management admin services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('serializes the current tenant and tenant-scoped users', async () => {
    const tenants = {
      findById: jest.fn().mockResolvedValue({
        id: 'tenant-1',
        name: 'Acme',
        slug: 'acme',
        status: TenantStatus.Active,
      }),
    };
    const users = {
      list: jest.fn().mockResolvedValue([
        {
          id: 'user-1',
          email: 'u@example.com',
          first_name: 'Ada',
          last_name: 'Lovelace',
          status: UserStatus.Active,
        },
      ]),
      findById: jest.fn(),
    };
    const service = new TenantService(tenants as never, users as never);

    await expect(run(() => service.getCurrentTenant())).resolves.toEqual({
      id: 'tenant-1',
      name: 'Acme',
      slug: 'acme',
      status: TenantStatus.Active,
    });
    await expect(run(() => service.listUsers())).resolves.toEqual({
      data: [
        {
          id: 'user-1',
          email: 'u@example.com',
          firstName: 'Ada',
          lastName: 'Lovelace',
          status: UserStatus.Active,
        },
      ],
    });
    expect(tenants.findById).toHaveBeenCalledWith('tenant-1', tx);
  });

  it('creates policies with tenant and actor from RequestContext', async () => {
    const repo = {
      create: jest.fn().mockImplementation(async (row) => ({ id: 'policy-1', ...row })),
    };
    const service = new PolicyService(repo as never);

    const result = await run(() =>
      service.create({ permission: 'expense.report.approve', effect: 'allow', rule: { amount: { lte: 100 } } }),
    );

    expect(result).toMatchObject({ id: 'policy-1', permission: 'expense.report.approve', isActive: true });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        created_by: 'actor-1',
        updated_by: 'actor-1',
      }),
      tx,
    );
  });

  it('creates invite rows with a hashed token and returns the raw token once', async () => {
    const repo = {
      create: jest.fn().mockImplementation(async (row) => ({ id: 'invite-1', ...row })),
    };
    const service = new InviteService(repo as never);

    const result = await run(() => service.create({ email: 'new@example.com', scope: Scope.OwnAndTeam }));
    const stored = repo.create.mock.calls[0][0] as { token_hash: string; status: InviteStatus };

    expect(result.token).toEqual(expect.any(String));
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.token_hash).not.toBe(result.token);
    expect(stored.status).toBe(InviteStatus.Pending);
  });

  it('throws not found when revoking a missing session', async () => {
    const repo = { revoke: jest.fn().mockResolvedValue(null) };
    const service = new SessionService(repo as never);

    await expect(run(() => service.revoke('missing-session'))).rejects.toThrow('Session not found');
  });

  it('serializes revoked session rows', async () => {
    const now = new Date('2026-06-27T00:00:00.000Z');
    const repo = {
      list: jest.fn().mockResolvedValue([
        {
          id: 'session-1',
          tenant_id: 'tenant-1',
          user_id: 'user-1',
          jti: 'jti-1',
          status: SessionStatus.Revoked,
          expires_at: now,
          revoked_at: now,
        },
      ]),
    };
    const service = new SessionService(repo as never);

    await expect(run(() => service.list())).resolves.toEqual({
      data: [
        {
          id: 'session-1',
          userId: 'user-1',
          jti: 'jti-1',
          status: SessionStatus.Revoked,
          expiresAt: now.toISOString(),
          revokedAt: now.toISOString(),
        },
      ],
    });
  });
});
