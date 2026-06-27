import { RuleConjunction } from '@aegis/shared-enums';
import type { Predicate, ValidatorContext } from './types';
import { getValidator } from './validators/registry';

/**
 * Evaluate one rule_step's query array with the load-bearing AND/OR semantics (docs §4.2):
 *   pass = andResults.every(true) && (orResults.empty || orResults.some(true))
 * Every AND predicate must hold; if any OR predicate exists, at least one must hold.
 */
export async function evaluateStep(ctx: ValidatorContext, query: Predicate[]): Promise<{ pass: boolean; trace: Array<{ field: string; result: boolean }> }> {
  const andResults: boolean[] = [];
  const orResults: boolean[] = [];
  const trace: Array<{ field: string; result: boolean }> = [];

  for (const predicate of query) {
    const result = await getValidator(predicate.field)(ctx, predicate);
    trace.push({ field: predicate.field, result });
    (predicate.conjunction === RuleConjunction.Or ? orResults : andResults).push(result);
  }

  const pass =
    andResults.every((r) => r === true) &&
    (orResults.length === 0 || orResults.some((r) => r === true));

  return { pass, trace };
}
