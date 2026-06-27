import { Scope } from '@aegis/shared-enums';
import {
  createInviteSchema,
  createPolicySchema,
  updatePolicySchema,
} from '../../src/validators/admin-surface.validator';

describe('admin surface validators', () => {
  it('accepts a policy rule payload', () => {
    const { error } = createPolicySchema.validate({
      permission: 'expense.report.approve',
      effect: 'allow',
      rule: { subject: { approvalLimit: { gte: 1000 } } },
      priority: 10,
    });
    expect(error).toBeUndefined();
  });

  it('rejects empty policy updates', () => {
    const { error } = updatePolicySchema.validate({});
    expect(error).toBeDefined();
  });

  it('accepts an invite with pre-assigned scope and teams', () => {
    const { error } = createInviteSchema.validate({
      email: 'new.user@demo-org.test',
      scope: Scope.OwnAndTeam,
      roleId: '11111111-1111-4111-8111-111111111111',
      teamIds: ['22222222-2222-4222-8222-222222222222'],
    });
    expect(error).toBeUndefined();
  });

  it('rejects malformed invite email', () => {
    const { error } = createInviteSchema.validate({ email: 'not-email' });
    expect(error).toBeDefined();
  });
});
