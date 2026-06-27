import Joi from 'joi';
import { RuleActionType, RuleConjunction, RuleEvent, RuleOperator } from '@aegis/shared-enums';

/** Joi schemas for the rule surface (create rule + run/dry-run). Applied via the `validate(...)` middleware. */

/** One header-level predicate of a rule_step.query array. */
const predicateSchema = Joi.object({
  field: Joi.string().min(1).required(),
  operator: Joi.string()
    .valid(...Object.values(RuleOperator))
    .required(),
  value: Joi.any().required(),
  conjunction: Joi.string()
    .valid(...Object.values(RuleConjunction))
    .required(),
});

export const createRuleSchema = Joi.object({
  name: Joi.string().min(2).required(),
  event: Joi.string()
    .valid(...Object.values(RuleEvent))
    .required(),
  active: Joi.boolean().optional(),
  steps: Joi.array()
    .items(
      Joi.object({
        order: Joi.number().integer().min(0).required(),
        query: Joi.array().items(predicateSchema).min(1).required(),
      }),
    )
    .min(1)
    .required(),
  actions: Joi.array()
    .items(
      Joi.object({
        type: Joi.string()
          .valid(...Object.values(RuleActionType))
          .required(),
        config: Joi.object().optional(),
      }),
    )
    .min(1)
    .required(),
});

export const runRuleSchema = Joi.object({
  facts: Joi.object().required(),
  dryRun: Joi.boolean().optional(),
});
