import { RuleActionType, RuleConjunction, RuleEvent, RuleOperator } from '@aegis/shared-enums';
import { createRuleSchema, runRuleSchema } from '../../src/validators/rule.validator';

describe('rule validators', () => {
  describe('createRuleSchema', () => {
    const validRule = {
      name: 'High-value approval',
      event: RuleEvent.RecordCreated,
      steps: [
        {
          order: 0,
          query: [
            {
              field: 'amount',
              operator: RuleOperator.GreaterThan,
              value: 100000,
              conjunction: RuleConjunction.And,
            },
          ],
        },
      ],
      actions: [{ type: RuleActionType.AutoApprove, config: {} }],
    };

    it('accepts a valid rule', () => {
      const { error } = createRuleSchema.validate(validRule);
      expect(error).toBeUndefined();
    });

    it('rejects a name shorter than 2 chars', () => {
      const { error } = createRuleSchema.validate({ ...validRule, name: 'x' });
      expect(error).toBeDefined();
    });

    it('rejects an unknown trigger event', () => {
      const { error } = createRuleSchema.validate({ ...validRule, event: 'not-an-event' });
      expect(error).toBeDefined();
    });

    it('rejects a rule with no steps', () => {
      const { error } = createRuleSchema.validate({ ...validRule, steps: [] });
      expect(error).toBeDefined();
    });

    it('rejects a rule with no actions', () => {
      const { error } = createRuleSchema.validate({ ...validRule, actions: [] });
      expect(error).toBeDefined();
    });

    it('rejects a predicate with an unknown operator', () => {
      const bad = {
        ...validRule,
        steps: [
          {
            order: 0,
            query: [
              { field: 'amount', operator: 'bogus', value: 1, conjunction: RuleConjunction.And },
            ],
          },
        ],
      };
      const { error } = createRuleSchema.validate(bad);
      expect(error).toBeDefined();
    });

    it('rejects an action with an unknown type', () => {
      const { error } = createRuleSchema.validate({
        ...validRule,
        actions: [{ type: 'teleport', config: {} }],
      });
      expect(error).toBeDefined();
    });
  });

  describe('runRuleSchema', () => {
    it('accepts a facts payload', () => {
      const { error } = runRuleSchema.validate({ facts: { amount: 5000 }, dryRun: true });
      expect(error).toBeUndefined();
    });

    it('requires facts', () => {
      const { error } = runRuleSchema.validate({ dryRun: true });
      expect(error).toBeDefined();
    });
  });
});
