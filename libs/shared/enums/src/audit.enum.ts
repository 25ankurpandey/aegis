/** Auditability vocabulary. See docs/10-auditability-and-compliance.md. */
export enum AuditAction {
  // authn
  LoginSucceeded = 'login.succeeded',
  LoginFailed = 'login.failed',
  TokenIssued = 'token.issued',
  TokenRevoked = 'token.revoked',
  // authz
  AccessGranted = 'access.granted',
  AccessDenied = 'access.denied',
  // administration
  RoleCreated = 'role.created',
  RoleUpdated = 'role.updated',
  RoleAssigned = 'role.assigned',
  PermissionGranted = 'permission.granted',
  PolicyChanged = 'policy.changed',
  // data
  RecordCreated = 'record.created',
  RecordUpdated = 'record.updated',
  RecordDeleted = 'record.deleted',
  SensitiveFieldRead = 'sensitive_field.read',
  // state transitions
  StateTransition = 'state.transition',
}

/** Outcome recorded alongside an audited action. */
export enum AuditOutcome {
  Success = 'success',
  Failure = 'failure',
  Denied = 'denied',
}
