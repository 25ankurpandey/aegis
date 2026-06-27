process.env['INTERNAL_JWT_SECRET'] = 'test-internal-secret';
import { signInternalToken, verifyInternalToken } from '../../src/auth/internal-auth';
import { ServiceName } from '@aegis/shared-enums';

describe('internal service token', () => {
  it('signs and verifies, carrying the source service', () => {
    const token = signInternalToken(ServiceName.Expense);
    const payload = verifyInternalToken(token);
    expect(payload['src']).toBe(ServiceName.Expense);
    expect(payload['aud']).toBe('aegis-internal');
  });

  it('rejects a tampered token', () => {
    const token = signInternalToken(ServiceName.Invoice);
    expect(() => verifyInternalToken(`${token}tamper`)).toThrow();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signInternalToken(ServiceName.Payroll);
    process.env['INTERNAL_JWT_SECRET'] = 'a-different-secret';
    expect(() => verifyInternalToken(token)).toThrow();
    process.env['INTERNAL_JWT_SECRET'] = 'test-internal-secret';
  });
});
