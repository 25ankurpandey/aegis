/**
 * @aegis/activity — shared, append-only, polymorphic business-activity timeline used by every
 * service. The same role @aegis/audit plays for security events, this plays for who-did-what
 * business timelines (record_type + record_id → any record). Tenant-scoped + RLS.
 */
export * from './activity-log.model';
export * from './activity-logger';
