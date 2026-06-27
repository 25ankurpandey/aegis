/** The deployable services. Also the valid values for the X-Source-Service header. */
export enum ServiceName {
  Gateway = 'gateway',
  UserManagement = 'user-management',
  Expense = 'expense',
  Payroll = 'payroll',
  Reporting = 'reporting',
  Workflow = 'workflow',
  Notification = 'notification',
  Invoice = 'invoice',
}

/** Source service for audit attribution (carried in X-Source-Service). */
export type SourceService = ServiceName;
