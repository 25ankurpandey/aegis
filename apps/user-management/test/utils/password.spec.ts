import { hashPassword, verifyPassword } from '../../src/utils/password';

describe('password hashing', () => {
  it('verifies a correct password', () => {
    const h = hashPassword('secret123');
    expect(verifyPassword('secret123', h)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const h = hashPassword('secret123');
    expect(verifyPassword('wrong-password', h)).toBe(false);
  });

  it('produces a different hash each time (random salt)', () => {
    expect(hashPassword('same')).not.toEqual(hashPassword('same'));
  });

  it('rejects a malformed stored hash', () => {
    expect(verifyPassword('x', 'not-a-valid-hash')).toBe(false);
  });
});
