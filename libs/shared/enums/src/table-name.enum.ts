/**
 * Single source of truth for physical table names. Every Sequelize model references TableName.<x>
 * so a schema rename is one line. Grouped by owning service. All tenant-scoped tables carry
 * tenant_id NOT NULL + Row-Level Security (see docs/04-multi-tenancy.md).
 */
export enum TableName {
  // identity / access (user-management)
  Tenants = 'tenants',
  Users = 'users',
  Memberships = 'memberships',
  Roles = 'roles',
  Permissions = 'permissions',
  RolePermissions = 'role_permissions',
  UserRoles = 'user_roles',
  Policies = 'policies',
  Teams = 'teams',
  TeamMembers = 'team_members',
  /** Per-tenant catalog of classification tags (Wave-6 — replaces the free-string `tags` JSONB). */
  Tags = 'tags',
  /** Team→tag mapping (governs which catalog tags a team may apply). */
  TeamTags = 'team_tags',
  /** Polymorphic record↔tag join across the three finance record types (keyed by ApprovalRecordType). */
  RecordTags = 'record_tags',
  OrgUnits = 'org_units',
  UserHierarchy = 'user_hierarchy',
  Invites = 'invites',
  Sessions = 'sessions',
  AuditLog = 'audit_log',
  TenantConfig = 'tenant_config',
  TenantFeatures = 'tenant_features',
  /** Transactional outbox: domain events staged inside the business tx, relayed to the bus at-least-once. */
  EventOutbox = 'event_outbox',

  // shared approval engine (@aegis/approvals) — one configurable multi-level engine for every record type
  /** Per-tenant policy defining HOW a record type is approved (mode, min_approvals, config). */
  ApprovalPolicies = 'approval_policies',
  /** Tenant manager/reporting hierarchy for manager-based approver resolution. */
  ApprovalHierarchy = 'approval_hierarchy',
  /** Named approver groups (a level can route to any member of a group). */
  ApproverGroups = 'approver_groups',
  /** Polymorphic group membership (user | role). */
  ApproverGroupMembers = 'approver_group_members',
  /** The resolved approver chain materialised for one record instance (per-record routing). */
  RecordApprovers = 'record_approvers',
  /** The immutable append-only vote ledger (one row per recorded decision). */
  Approvals = 'approvals',

  // expense
  ExpenseReports = 'expense_reports',
  Expenses = 'expenses',
  ExpenseCategories = 'expense_categories',
  ExpenseApprovals = 'expense_approvals',
  ExpenseComments = 'expense_comments',
  ExpenseActivities = 'expense_activities',

  // invoice (header-level)
  Invoices = 'invoices',
  InvoiceMetadata = 'invoice_metadata',
  InvoiceDuplicates = 'invoice_duplicates',
  InvoiceApprovals = 'invoice_approvals',
  InvoiceActivities = 'invoice_activities',

  // workflow
  Rules = 'rules',
  RuleSteps = 'rule_steps',
  RuleActions = 'rule_actions',
  RuleAuditLogs = 'rule_audit_logs',

  // payroll
  Employees = 'employees',
  EmploymentContracts = 'employment_contracts',
  PayCalendars = 'pay_calendars',
  EarningCodes = 'earning_codes',
  DeductionCodes = 'deduction_codes',
  TaxRules = 'tax_rules',
  EmployeePayItems = 'employee_pay_items',
  PayRuns = 'pay_runs',
  Payslips = 'payslips',
  PayslipLines = 'payslip_lines',
  PayrollInputItems = 'payroll_input_items',
  Payments = 'payments',
  PaymentBatches = 'payment_batches',
  LedgerEntries = 'ledger_entries',

  // notification
  Notifications = 'notifications',
  EmailNotificationLogs = 'email_notification_logs',
  /** Per-tenant / per-user notification channel preferences (which channels for which event types). */
  NotificationPreferences = 'notification_preferences',
  /** Per-tenant email suppression list (bounced/complained/unsubscribed addresses), checked pre-send. */
  EmailSuppressions = 'email_suppressions',

  // shared activity tracking (@aegis/activity) — one polymorphic who-did-what timeline for every record
  ActivityLog = 'activity_log',

  // reporting
  ReportDefinitions = 'report_definitions',
  ReportSchedules = 'report_schedules',
  ReportRuns = 'report_runs',
  ReportAccessPolicies = 'report_access_policies',

  // connectors
  ConnectorConfigs = 'connector_configs',
  ConnectorSyncLog = 'connector_sync_log',
  /** Durable per-record ERP sync state (status, attempts, external id, last error) for reconciliation. */
  ConnectorSyncState = 'connector_sync_state',
}
