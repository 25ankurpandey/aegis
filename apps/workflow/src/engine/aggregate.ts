import { RuleRunStatus } from '@aegis/shared-enums';
import type { ActionStatus } from './types';

/**
 * Fold the per-action statuses into one rule_audit_logs verdict (docs §4.5):
 *   all success/no_update  → success
 *   all skip               → skipped
 *   a mix                  → partial_success
 *   (an escaped exception is handled by the executor → error)
 */
export function aggregateVerdict(actionStatuses: ActionStatus[]): RuleRunStatus {
  if (actionStatuses.length === 0) return RuleRunStatus.Skipped;
  if (actionStatuses.some((s) => s === 'error') && actionStatuses.some((s) => s === 'success'))
    return RuleRunStatus.PartialSuccess;
  const allOk = actionStatuses.every((s) => s === 'success' || s === 'no_update');
  const allSkip = actionStatuses.every((s) => s === 'skip');
  if (allOk) return RuleRunStatus.Success;
  if (allSkip) return RuleRunStatus.Skipped;
  if (actionStatuses.every((s) => s === 'error')) return RuleRunStatus.Error;
  return RuleRunStatus.PartialSuccess;
}
