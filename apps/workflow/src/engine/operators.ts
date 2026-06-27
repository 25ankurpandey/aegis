import { RuleOperator } from '@aegis/shared-enums';
import { ErrUtils } from '@aegis/service-core';

/**
 * Numeric comparison in integer minor units (money is always compared as bigint, SPEC §9).
 * `between` takes a [lo, hi] tuple; all other operators take a scalar rhs.
 */
export function compareNumeric(op: RuleOperator, lhs: bigint, rhs: bigint | [bigint, bigint]): boolean {
  switch (op) {
    case RuleOperator.Equal:
      return lhs === (rhs as bigint);
    case RuleOperator.NotEqual:
      return lhs !== (rhs as bigint);
    case RuleOperator.LessThan:
      return lhs < (rhs as bigint);
    case RuleOperator.LessOrEqual:
      return lhs <= (rhs as bigint);
    case RuleOperator.GreaterThan:
      return lhs > (rhs as bigint);
    case RuleOperator.GreaterOrEqual:
      return lhs >= (rhs as bigint);
    case RuleOperator.Between: {
      const [lo, hi] = rhs as [bigint, bigint];
      return lhs >= lo && lhs <= hi;
    }
    default:
      throw ErrUtils.validation(`Unsupported numeric operator '${op}'`);
  }
}

/** Coerce an arbitrary value to bigint minor units; throws a typed validation error otherwise. */
export function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw ErrUtils.validation(`Expected an integer minor-unit value, got '${String(value)}'`);
}
