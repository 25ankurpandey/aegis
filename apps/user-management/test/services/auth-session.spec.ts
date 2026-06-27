import jwt from 'jsonwebtoken';
import { SessionStatus, Scope, SystemRole, UserStatus } from '@aegis/shared-enums';

const tx = { tx: true };
const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
const auditRecord = jest.fn();

jest.mock('@aegis/db', () => ({
  withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])),
}));
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: (...a: unknown[]) => auditRecord(...a) } }));

import { RequestContext } from '@aegis/service-core';
import { AuthService } from '../../src/services/auth.service';
import { hashPassword } from '../../src/utils/password';

const SECRET = 'test-secret';

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 'tenant-1', userId: 'actor-1', correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

describe('AuthService.login — session issuance', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_SECRET = SECRET;
    process.env.TOKEN_TTL_SECONDS = '300';
    jest.clearAllMocks();
  });

  it('creates a session row and signs the JWT with its jti', async () => {
    const users = {
      findByEmail: jest.fn().mockResolvedValue({
        id: 'user-1',
        tenant_id: 'tenant-1',
        email: 'user@example.com',
        password_hash: hashPassword('password-1'),
        status: UserStatus.Active,
      }),
      getAccess: jest.fn().mockResolvedValue({
        roles: [SystemRole.Admin],
        permissions: ['tenant.view'],
        scope: Scope.AllRecords,
      }),
    };
    const sessions = {
      create: jest.fn().mockImplementation(async (row) => ({ id: 'session-1', ...row })),
    };
    const service = new AuthService(users as never, sessions as never);

    const result = await run(() => service.login({ email: 'user@example.com', password: 'password-1' }));
    const claims = jwt.verify(result.token, SECRET) as jwt.JwtPayload;

    expect(result.sessionId).toBe('session-1');
    expect(claims.jti).toEqual(expect.any(String));
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        jti: claims.jti,
        status: SessionStatus.Active,
      }),
      tx,
    );
    expect(auditRecord).toHaveBeenCalled();
  });
});
