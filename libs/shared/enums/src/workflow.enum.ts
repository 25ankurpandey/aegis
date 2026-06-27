/** Rules-as-data workflow engine. See docs/services/workflow.md. */
export enum RuleEvent {
  RecordCreated = 'record.created',
  RecordUpdated = 'record.updated',
  RecordSubmitted = 'record.submitted',
  ApprovalCompleted = 'approval.completed',
}

export enum RuleConjunction {
  And = 'AND',
  Or = 'OR',
}

/** Operators usable in a rule_step query predicate. */
export enum RuleOperator {
  Equal = 'eq',
  NotEqual = 'neq',
  GreaterThan = 'gt',
  GreaterOrEqual = 'gte',
  LessThan = 'lt',
  LessOrEqual = 'lte',
  Between = 'between',
  In = 'in',
  Contains = 'contains',
  HasAny = 'has_any',
  HasAll = 'has_all',
  HasNone = 'has_none',
}

/** Action types dispatched when a rule matches (extend by registering a handler). */
export enum RuleActionType {
  AutoApprove = 'auto_approve',
  AssignApprovalPolicy = 'assign_approval_policy',
  AssignTeam = 'assign_team',
  AssignOwner = 'assign_owner',
  AddTag = 'add_tag',
  Notify = 'notify',
  PushToConnector = 'push_to_connector',
}

/** Per-run audit verdict. */
export enum RuleRunStatus {
  Success = 'success',
  Skipped = 'skipped',
  PartialSuccess = 'partial_success',
  Error = 'error',
}
