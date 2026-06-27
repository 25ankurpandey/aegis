import {
  recipientDirectoryQuerySchema,
  userContactParamSchema,
} from '../../src/validators/internal-recipient.validator';

describe('internal recipient validators', () => {
  it('accepts a UUID user contact param', () => {
    const { error } = userContactParamSchema.validate({
      id: '11111111-1111-4111-8111-111111111111',
    });
    expect(error).toBeUndefined();
  });

  it('requires exactly one audience selector', () => {
    expect(recipientDirectoryQuerySchema.validate({}).error).toBeDefined();
    expect(
      recipientDirectoryQuerySchema.validate({
        role: 'approver',
        tenantAdmins: true,
      }).error,
    ).toBeDefined();
    expect(recipientDirectoryQuerySchema.validate({ role: 'approver' }).error).toBeUndefined();
  });

  it('coerces the tenantAdmins query string flag', () => {
    const { error, value } = recipientDirectoryQuerySchema.validate({ tenantAdmins: 'true' });
    expect(error).toBeUndefined();
    expect(value).toEqual({ tenantAdmins: true });
  });
});
