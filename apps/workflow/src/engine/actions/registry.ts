import { ErrUtils } from '@aegis/service-core';
import type { RuleActionType } from '@aegis/shared-enums';
import type { ActionHandler } from '../types';

/**
 * Action-type → handler registry. Implemented as a Record keyed by RuleActionType so a new action
 * is one registered function; the executor's aggregation/audit is unchanged regardless of how many
 * handlers exist. The engine core never changes.
 */
const handlers: Partial<Record<RuleActionType, ActionHandler>> = {};

export function registerAction(type: RuleActionType, fn: ActionHandler): void {
  handlers[type] = fn;
}

export function getActionHandler(type: RuleActionType): ActionHandler {
  const fn = handlers[type];
  if (!fn) throw ErrUtils.validation(`Unknown action type '${type}'`);
  return fn;
}

export function hasActionHandler(type: RuleActionType): boolean {
  return Boolean(handlers[type]);
}

export function registeredActionTypes(): RuleActionType[] {
  return Object.keys(handlers) as RuleActionType[];
}
