/**
 * Live E2E — register / login / JWT (FLOWS_v2 + flow-catalogue auth surface, E2E tier).
 *
 * SKIPPED unless `E2E_BASE_URL` points at a running gateway (see lib/client.ts). Drives the public
 * gateway exactly as an external client: register a fresh user in tenant A, log in the seeded admin,
 * and confirm the issued JWT is accepted by an authenticated read (`/auth/me`).
 */
import { api, describeE2E, login, FIXTURES, uniqueSuffix } from './lib/client';

describeE2E('live: auth (register / login / JWT)', () => {
  it('rejects login with no x-tenant-id header (fail-closed context)', async () => {
    // Missing the required tenant header → the context middleware fails closed with a 4xx, never 200.
    const res = await api('/user-management/v1/auth/login', {
      method: 'POST',
      // Deliberately blank tenant to exercise the fail-closed header check.
      tenantId: '',
      body: { email: FIXTURES.tenantA.email, password: FIXTURES.tenantA.password },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('registers a new user in tenant A and rejects a duplicate email', async () => {
    const email = `e2e-user-${uniqueSuffix()}@demo-org.test`;
    const created = await api<{ id: string; email: string }>('/user-management/v1/auth/register', {
      method: 'POST',
      tenantId: FIXTURES.tenantA.id,
      body: { email, password: 'e2e-password-123', firstName: 'E2E', lastName: 'User' },
    });
    expect(created.status).toBe(201);
    expect(created.body.email).toBe(email);

    // Same email in the same tenant → validation error (409/400), not a second row.
    const dup = await api('/user-management/v1/auth/register', {
      method: 'POST',
      tenantId: FIXTURES.tenantA.id,
      body: { email, password: 'e2e-password-123' },
    });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect(dup.status).toBeLessThan(500);
  });

  it('logs in the seeded admin and the JWT is accepted by an authenticated route', async () => {
    const { token, userId } = await login(FIXTURES.tenantA);
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // header.payload.signature

    const me = await api<{ id: string; email: string }>('/user-management/v1/auth/me', {
      tenantId: FIXTURES.tenantA.id,
      token,
    });
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(userId);
    expect(me.body.email).toBe(FIXTURES.tenantA.email);
  });

  it('rejects a request whose token tenant does not match the x-tenant-id header', async () => {
    // Tenant A's token presented with tenant B's header → defence-in-depth 403 in authenticate().
    const { token } = await login(FIXTURES.tenantA);
    const res = await api('/user-management/v1/auth/me', {
      tenantId: FIXTURES.tenantB.id,
      token,
    });
    expect(res.status).toBe(403);
  });
});
