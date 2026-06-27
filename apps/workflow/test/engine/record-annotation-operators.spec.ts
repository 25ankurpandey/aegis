import { EventTopic } from '@aegis/events';
import { RuleActionType, RuleConjunction, RuleOperator } from '@aegis/shared-enums';

const publish = jest.fn();

jest.mock('@aegis/events', () => {
  const actual = jest.requireActual('@aegis/events');
  return {
    ...actual,
    getBus: () => ({ publish }),
  };
});

import { evaluateStep, getActionHandler, registerBuiltinEngine } from '../../src/engine';

describe('record annotation rule operators/actions', () => {
  beforeAll(() => registerBuiltinEngine());

  beforeEach(() => publish.mockClear());

  it('supports set predicates over tags', async () => {
    const ctx = { tenantId: 't1', record: { tags: ['urgent', 'finance'] } };
    await expect(
      evaluateStep(ctx, [
        {
          field: 'tags',
          operator: RuleOperator.HasAny,
          value: ['urgent'],
          conjunction: RuleConjunction.And,
        },
        {
          field: 'tags',
          operator: RuleOperator.HasAll,
          value: ['urgent', 'finance'],
          conjunction: RuleConjunction.And,
        },
        {
          field: 'tags',
          operator: RuleOperator.HasNone,
          value: ['legal'],
          conjunction: RuleConjunction.And,
        },
      ]),
    ).resolves.toMatchObject({ pass: true });
  });

  it('supports scalar predicates over assignee_id', async () => {
    const ctx = { tenantId: 't1', record: { assignee_id: 'user-1' } };
    await expect(
      evaluateStep(ctx, [
        {
          field: 'assignee_id',
          operator: RuleOperator.Equal,
          value: 'user-1',
          conjunction: RuleConjunction.And,
        },
      ]),
    ).resolves.toMatchObject({ pass: true });
  });

  it('assign_owner emits a RecordUpdated payload with assigneeId', async () => {
    const handler = getActionHandler(RuleActionType.AssignOwner);
    await handler(
      {
        tenantId: 't1',
        record: { record_type: 'expense_report', id: 'rep-1' },
        rule: { id: 'rule-1', name: 'r', event: 'record.submitted' },
      },
      { type: RuleActionType.AssignOwner, config: { assigneeId: 'user-2' } },
    );

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: EventTopic.RecordUpdated,
        payload: expect.objectContaining({
          recordType: 'expense_report',
          recordId: 'rep-1',
          assigneeId: 'user-2',
        }),
      }),
    );
  });
});
