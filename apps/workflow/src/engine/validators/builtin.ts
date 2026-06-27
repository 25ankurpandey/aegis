import { RuleOperator } from '@aegis/shared-enums';
import type { Predicate, ValidatorContext } from '../types';
import { registerValidator } from './registry';
import { compareNumeric, toBigInt } from '../operators';

/**
 * Built-in header-level validators. All read an attribute off `ctx.record` (the facts payload) and
 * compare it with the predicate. Money fields run through `compareNumeric` in integer minor units.
 */

/** Generic scalar/array comparison for non-money fields. */
function compareScalar(op: RuleOperator, lhs: unknown, rhs: unknown): boolean {
  switch (op) {
    case RuleOperator.Equal:
      return lhs === rhs;
    case RuleOperator.NotEqual:
      return lhs !== rhs;
    case RuleOperator.In:
      return Array.isArray(rhs) && rhs.includes(lhs);
    case RuleOperator.Contains:
      if (Array.isArray(lhs)) return lhs.includes(rhs);
      return typeof lhs === 'string' && typeof rhs === 'string' && lhs.includes(rhs);
    case RuleOperator.GreaterThan:
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs > rhs;
    case RuleOperator.GreaterOrEqual:
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs >= rhs;
    case RuleOperator.LessThan:
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs < rhs;
    case RuleOperator.LessOrEqual:
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs <= rhs;
    default:
      return false;
  }
}

function asStringSet(value: unknown): Set<string> {
  const values = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value];
  return new Set(values.map((item) => String(item).toLowerCase()));
}

function compareSet(op: RuleOperator, lhs: unknown, rhs: unknown): boolean {
  const left = asStringSet(lhs);
  const right = asStringSet(rhs);
  switch (op) {
    case RuleOperator.HasAny:
      return [...right].some((item) => left.has(item));
    case RuleOperator.HasAll:
      return [...right].every((item) => left.has(item));
    case RuleOperator.HasNone:
      return [...right].every((item) => !left.has(item));
    case RuleOperator.Contains:
      return compareScalar(op, Array.isArray(lhs) ? lhs.map(String) : lhs, rhs);
    default:
      return compareScalar(op, lhs, rhs);
  }
}

/** Money comparison in integer minor units. */
function numericValidator(field: string): void {
  registerValidator(field, (ctx: ValidatorContext, p: Predicate) => {
    const lhs = toBigInt(ctx.record[field]);
    const rhs =
      p.operator === RuleOperator.Between && Array.isArray(p.value)
        ? ([toBigInt(p.value[0]), toBigInt(p.value[1])] as [bigint, bigint])
        : toBigInt(p.value);
    return compareNumeric(p.operator, lhs, rhs);
  });
}

/** Plain scalar/enum/string comparison. */
function scalarValidator(field: string): void {
  registerValidator(field, (ctx: ValidatorContext, p: Predicate) =>
    compareScalar(p.operator, ctx.record[field], p.value),
  );
}

/** Set comparison for tag/label arrays. */
function setValidator(field: string): void {
  registerValidator(field, (ctx: ValidatorContext, p: Predicate) =>
    compareSet(p.operator, ctx.record[field], p.value),
  );
}

/** Register the built-in header-level validators (called once at bootstrap). */
export function registerBuiltinValidators(): void {
  // money / numeric (integer minor units)
  numericValidator('amount');

  // header attributes
  scalarValidator('status');
  scalarValidator('vendor');
  scalarValidator('category');
  scalarValidator('owner_user_id');
  scalarValidator('team_id');
  scalarValidator('assignee_id');
  setValidator('tags');
  scalarValidator('currency');
  scalarValidator('record_type');
}
