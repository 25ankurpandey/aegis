import { evalCondition, conditionsMatch } from '../src/condition-evaluator';
import { Permission } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';

const req = (over: Partial<AccessShape.AccessRequest> = {}): AccessShape.AccessRequest => ({
  principal: {
    userId: 'u1',
    tenantId: 't1',
    roles: [],
    permissions: [],
    attributes: { teamIds: ['teamA'], managerOf: ['u2'] },
  },
  action: Permission.ExpenseReportApprove,
  resource: { type: 'expense_report', tenantId: 't1', ownerId: 'u1', teamId: 'teamA', attributes: { amount: 100 } },
  ...over,
});

describe('ABAC condition evaluator', () => {
  it('numeric operators', () => {
    expect(evalCondition({ attribute: 'resource.amount', operator: 'eq', value: 100 }, req())).toBe(true);
    expect(evalCondition({ attribute: 'resource.amount', operator: 'gt', value: 50 }, req())).toBe(true);
    expect(evalCondition({ attribute: 'resource.amount', operator: 'lte', value: 50 }, req())).toBe(false);
  });

  it('owner', () => {
    expect(evalCondition({ attribute: '', operator: 'owner' }, req())).toBe(true);
    expect(evalCondition({ attribute: '', operator: 'owner' }, req({ resource: { type: 'r', ownerId: 'someone-else' } }))).toBe(false);
  });

  it('manager_of', () => {
    expect(evalCondition({ attribute: '', operator: 'manager_of' }, req({ resource: { type: 'r', ownerId: 'u2' } }))).toBe(true);
    expect(evalCondition({ attribute: '', operator: 'manager_of' }, req({ resource: { type: 'r', ownerId: 'u9' } }))).toBe(false);
  });

  it('tenant_match', () => {
    expect(evalCondition({ attribute: '', operator: 'tenant_match' }, req())).toBe(true);
    expect(evalCondition({ attribute: '', operator: 'tenant_match' }, req({ resource: { type: 'r', tenantId: 't2' } }))).toBe(false);
  });

  it('in / contains', () => {
    expect(evalCondition({ attribute: 'resource.amount', operator: 'in', value: [100, 200] }, req())).toBe(true);
    expect(evalCondition({ attribute: 'principal.teamIds', operator: 'contains', value: 'teamA' }, req())).toBe(true);
  });

  it('conditionsMatch uses AND semantics', () => {
    expect(
      conditionsMatch(
        [{ attribute: 'resource.amount', operator: 'gt', value: 50 }, { attribute: '', operator: 'owner' }],
        req(),
      ),
    ).toBe(true);
    expect(conditionsMatch([{ attribute: 'resource.amount', operator: 'gt', value: 500 }], req())).toBe(false);
    expect(conditionsMatch(undefined, req())).toBe(true); // vacuously true
  });
});
