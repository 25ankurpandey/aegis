/**
 * Access-control vocabulary. See docs/03-access-control-model.md.
 * Permissions are dotted `domain.action[.sub]` strings, the unit checked by the PDP.
 */
export enum Permission {
  // tenant / platform admin
  TenantManage = 'tenant.manage',
  TenantView = 'tenant.view',

  // identity & access administration (PAP)
  UserCreate = 'user.create',
  UserView = 'user.view',
  UserUpdate = 'user.update',
  UserInvite = 'user.invite',
  SessionView = 'session.view',
  SessionRevoke = 'session.revoke',
  RoleCreate = 'role.create',
  RoleView = 'role.view',
  RoleUpdate = 'role.update',
  RoleDelete = 'role.delete',
  RoleAssign = 'role.assign',
  PermissionView = 'permission.view',
  PolicyView = 'policy.view',
  PolicyManage = 'policy.manage',
  TeamManage = 'team.manage',
  OrgManage = 'org.manage',
  TagCreate = 'tag.create',
  TagUpdate = 'tag.update',
  TagDelete = 'tag.delete',
  TagList = 'tag.list',
  RecordTagAdd = 'record.tag.add',
  RecordTagRemove = 'record.tag.remove',
  RecordAssign = 'record.assign',
  TeamTagManage = 'team.tag.manage',

  // expense
  ExpenseReportCreate = 'expense.report.create',
  ExpenseReportView = 'expense.report.view',
  ExpenseReportUpdate = 'expense.report.update',
  ExpenseReportSubmit = 'expense.report.submit',
  ExpenseReportApprove = 'expense.report.approve',
  ExpenseReportReject = 'expense.report.reject',
  ExpenseReportReimburse = 'expense.report.reimburse',

  // invoice (header-level)
  InvoiceCreate = 'invoice.create',
  InvoiceView = 'invoice.view',
  InvoiceUpdate = 'invoice.update',
  InvoiceApprove = 'invoice.approve',

  // payroll (highly sensitive — granular)
  PayrollEmployeeView = 'payroll.employee.view',
  PayrollEmployeeManage = 'payroll.employee.manage',
  PayrollSensitiveRead = 'payroll.sensitive.read',
  PayRunCreate = 'payroll.run.create',
  PayRunCalculate = 'payroll.run.calculate',
  PayRunApprove = 'payroll.run.approve',
  PayRunDisburse = 'payroll.run.disburse',
  PayslipViewOwn = 'payroll.payslip.view.own',
  PayslipViewAll = 'payroll.payslip.view.all',

  // workflow
  RuleCreate = 'workflow.rule.create',
  RuleView = 'workflow.rule.view',
  RuleUpdate = 'workflow.rule.update',
  RuleRun = 'workflow.rule.run',

  // reporting
  ReportDefine = 'report.define',
  ReportRun = 'report.run',
  ReportView = 'report.view',

  // notification
  NotificationView = 'notification.view',

  // connectors (ERP)
  ConnectorManage = 'connector.manage',
  ConnectorPush = 'connector.push',

  // audit
  AuditView = 'audit.view',
}

/** Seeded system roles (tenants may also define custom roles with tenant_id set). */
export enum SystemRole {
  Owner = 'owner',
  Admin = 'admin',
  Manager = 'manager',
  Approver = 'approver',
  Contributor = 'contributor',
  Viewer = 'viewer',
  PayrollAdmin = 'payroll_admin',
  PayrollApprover = 'payroll_approver',
  FinanceDisburser = 'finance_disburser',
  Auditor = 'auditor',
  Employee = 'employee',
}

/** Row-level visibility scope attached to a user_role; compiles to query predicates + RLS. */
export enum Scope {
  AllRecords = 'all_records',
  OwnAndTeam = 'own_and_team',
  OwnOnly = 'own_only',
}

/** Terminal verdict of a PDP decision. */
export enum Decision {
  Allow = 'allow',
  Deny = 'deny',
}
