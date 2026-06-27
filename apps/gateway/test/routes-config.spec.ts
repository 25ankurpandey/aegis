import { ROUTES } from '../src/routes-config';
import { ServiceName } from '@aegis/shared-enums';

describe('gateway routes-config', () => {
  it('routes all seven downstream services', () => {
    expect(Object.keys(ROUTES).sort()).toEqual(
      ['expense', 'invoice', 'notification', 'payroll', 'reporting', 'user-management', 'workflow'].sort(),
    );
  });

  it('maps each segment to a distinct ServiceName', () => {
    const svcs = Object.values(ROUTES).map((r) => r.svc);
    expect(new Set(svcs).size).toBe(svcs.length);
  });

  it('maps the user-management segment to the UserManagement service on port 4001', () => {
    const route = ROUTES['user-management'];
    expect(route.svc).toBe(ServiceName.UserManagement);
    expect(route.env).toBe('USER_MANAGEMENT_URL');
    expect(route.defaultUrl).toBe('http://localhost:4001');
  });

  it('gives every route an env var and a distinct local default URL', () => {
    const urls = new Set<string>();
    for (const route of Object.values(ROUTES)) {
      expect(route.env).toMatch(/^[A-Z_]+_URL$/);
      expect(route.defaultUrl).toMatch(/^http:\/\/localhost:40\d{2}$/);
      urls.add(route.defaultUrl);
    }
    expect(urls.size).toBe(Object.keys(ROUTES).length);
  });
});
