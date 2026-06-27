import type { RuleActionType } from '@aegis/shared-enums';
import { WorkflowShape } from '@aegis/shared-types';

/**
 * Engine-internal contracts (the validator/action handler surfaces). The data contracts the engine
 * shares with the rest of the service — the predicate + facts shapes — live in `@aegis/shared-types`
 * (SPEC §11.2); they are re-exported here as the engine's `Predicate`/`Facts` so engine modules keep
 * a single import site.
 */
export type Predicate = WorkflowShape.Predicate;
export type Facts = WorkflowShape.Facts;

/** Context handed to every field validator. */
export interface ValidatorContext {
  record: Facts;
  tenantId: string;
}

/** A field validator reads its attribute off the record and compares per operator/value. */
export type FieldValidator = (
  ctx: ValidatorContext,
  predicate: Predicate,
) => Promise<boolean> | boolean;

/** Typed status returned by an action handler (folded into the run verdict). */
export type ActionStatus = 'success' | 'error' | 'skip' | 'no_update';

/** Context handed to every action handler. */
export interface ActionContext {
  tenantId: string;
  record: Facts;
  rule: { id: string; name: string; event: string };
}

/** A single action row as persisted (type + free-form config). */
export interface ActionSpec {
  type: RuleActionType;
  config: Record<string, unknown>;
}

/** An action handler performs the side effect (usually a follow-on event) and returns a status. */
export type ActionHandler = (
  ctx: ActionContext,
  action: ActionSpec,
) => Promise<ActionStatus> | ActionStatus;
