import { ServiceName } from '@aegis/shared-enums';

/** A single gateway route target: the logical service, its URL env var, and a local fallback URL. */
export interface RouteTarget {
  svc: ServiceName;
  env: string;
  defaultUrl: string;
}

/**
 * First path segment → target service. The gateway is the single entry point; every downstream
 * service independently enforces auth via its PEP (defense in depth). Keep this map in sync with the
 * `*_URL` env vars in `.env` and `docker-compose.all.yml`.
 */
export const ROUTES: Record<string, RouteTarget> = {
  'user-management': { svc: ServiceName.UserManagement, env: 'USER_MANAGEMENT_URL', defaultUrl: 'http://localhost:4001' },
  expense: { svc: ServiceName.Expense, env: 'EXPENSE_URL', defaultUrl: 'http://localhost:4002' },
  payroll: { svc: ServiceName.Payroll, env: 'PAYROLL_URL', defaultUrl: 'http://localhost:4003' },
  reporting: { svc: ServiceName.Reporting, env: 'REPORTING_URL', defaultUrl: 'http://localhost:4004' },
  workflow: { svc: ServiceName.Workflow, env: 'WORKFLOW_URL', defaultUrl: 'http://localhost:4005' },
  notification: { svc: ServiceName.Notification, env: 'NOTIFICATION_URL', defaultUrl: 'http://localhost:4006' },
  invoice: { svc: ServiceName.Invoice, env: 'INVOICE_URL', defaultUrl: 'http://localhost:4007' },
};
