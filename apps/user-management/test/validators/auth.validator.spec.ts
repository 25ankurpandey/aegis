import { registerSchema, loginSchema } from '../../src/validators/auth.validator';

describe('auth validators', () => {
  describe('registerSchema', () => {
    it('accepts a valid registration', () => {
      const { error, value } = registerSchema.validate({
        email: 'user@example.com',
        password: 'longenough',
        firstName: 'Ada',
      });
      expect(error).toBeUndefined();
      expect(value.email).toBe('user@example.com');
    });

    it('accepts reserved test-domain emails used by seeded fixtures', () => {
      const { error } = registerSchema.validate({
        email: 'user@demo-org.test',
        password: 'longenough',
      });
      expect(error).toBeUndefined();
    });

    it('rejects a non-email address', () => {
      const { error } = registerSchema.validate({ email: 'not-an-email', password: 'longenough' });
      expect(error).toBeDefined();
    });

    it('rejects a password shorter than 8 chars', () => {
      const { error } = registerSchema.validate({ email: 'user@example.com', password: 'short' });
      expect(error).toBeDefined();
    });

    it('requires email and password', () => {
      const { error } = registerSchema.validate({});
      expect(error).toBeDefined();
    });
  });

  describe('loginSchema', () => {
    it('accepts valid credentials', () => {
      const { error } = loginSchema.validate({ email: 'admin@demo-org.test', password: 'anything' });
      expect(error).toBeUndefined();
    });

    it('rejects a missing password', () => {
      const { error } = loginSchema.validate({ email: 'user@example.com' });
      expect(error).toBeDefined();
    });
  });
});
