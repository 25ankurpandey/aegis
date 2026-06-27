import { createEmployeeSchema } from '../../src/validators/employee.validator';

describe('employee validators', () => {
  describe('createEmployeeSchema', () => {
    it('accepts a minimal valid employee', () => {
      const { error } = createEmployeeSchema.validate({ workJurisdiction: 'US-CA' });
      expect(error).toBeUndefined();
    });

    it('accepts the optional sensitive fields', () => {
      const { error } = createEmployeeSchema.validate({
        workJurisdiction: 'US-CA',
        userId: '22222222-2222-4222-8222-222222222222',
        bankAccount: '1234567890',
        nationalId: 'AB123456',
        personRef: '11111111-1111-4111-8111-111111111111',
      });
      expect(error).toBeUndefined();
    });

    it('requires workJurisdiction', () => {
      const { error } = createEmployeeSchema.validate({});
      expect(error).toBeDefined();
    });

    it('rejects a too-short workJurisdiction', () => {
      const { error } = createEmployeeSchema.validate({ workJurisdiction: 'X' });
      expect(error).toBeDefined();
    });

    it('rejects a non-uuid personRef', () => {
      const { error } = createEmployeeSchema.validate({ workJurisdiction: 'US-CA', personRef: 'nope' });
      expect(error).toBeDefined();
    });

    it('rejects a non-uuid userId', () => {
      const { error } = createEmployeeSchema.validate({ workJurisdiction: 'US-CA', userId: 'nope' });
      expect(error).toBeDefined();
    });
  });
});
