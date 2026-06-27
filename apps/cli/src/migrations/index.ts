import type { MigrationModule } from '@aegis/db';
import * as identity from './0001_identity';
import * as invoice from './0002_invoice';
import * as expense from './0003_expense';
import * as workflow from './0004_workflow';
import * as payroll from './0005_payroll';
import * as notification from './0006_notification';
import * as reporting from './0007_reporting';
import * as audit from './0008_audit';
import * as casbin from './0009_casbin';
import * as tenantConfig from './0010_tenant_config';
import * as eventOutbox from './0011_event_outbox';
import * as approvals from './0012_approvals';
import * as approvalsSupersede from './0013_approvals_supersede';
import * as notificationPreferences from './0014_notification_preferences';
import * as activity from './0015_activity';
import * as expenseRecallActivity from './0016_expense_recall_activity';
import * as invoiceDedup from './0017_invoice_dedup';
import * as payrollTax from './0018_payroll_tax';
import * as emailPlane from './0019_email_plane';
import * as connectorSyncState from './0020_connector_sync_state';
import * as invoiceDedupCurrency from './0021_invoice_dedup_currency';
import * as recordTeamTags from './0022_record_team_tags';
import * as teams from './0023_teams';
import * as tags from './0024_tags';
import * as recordAnnotations from './0025_record_annotations';
import * as connectorConfigs from './0026_connector_configs';
import * as employeeUserBinding from './0027_employee_user_binding';
import * as identityAdminSurfaces from './0028_identity_admin_surfaces';
import * as rlsPermissiveBase from './0029_rls_permissive_base';
import * as eventOutboxRlsSafeTenantCast from './0030_event_outbox_rls_safe_tenant_cast';
import * as auditHashCanonicalization from './0031_audit_hash_canonicalization';

/** Ordered list of schema migrations (explicit imports so the bundled CLI can run them). */
export const migrations: MigrationModule[] = [
  { name: '0001_identity', up: identity.up, down: identity.down },
  { name: '0002_invoice', up: invoice.up, down: invoice.down },
  { name: '0003_expense', up: expense.up, down: expense.down },
  { name: '0004_workflow', up: workflow.up, down: workflow.down },
  { name: '0005_payroll', up: payroll.up, down: payroll.down },
  { name: '0006_notification', up: notification.up, down: notification.down },
  { name: '0007_reporting', up: reporting.up, down: reporting.down },
  { name: '0008_audit', up: audit.up, down: audit.down },
  { name: '0009_casbin', up: casbin.up, down: casbin.down },
  { name: '0010_tenant_config', up: tenantConfig.up, down: tenantConfig.down },
  { name: '0011_event_outbox', up: eventOutbox.up, down: eventOutbox.down },
  { name: '0012_approvals', up: approvals.up, down: approvals.down },
  { name: '0013_approvals_supersede', up: approvalsSupersede.up, down: approvalsSupersede.down },
  { name: '0014_notification_preferences', up: notificationPreferences.up, down: notificationPreferences.down },
  { name: '0015_activity', up: activity.up, down: activity.down },
  { name: '0016_expense_recall_activity', up: expenseRecallActivity.up, down: expenseRecallActivity.down },
  { name: '0017_invoice_dedup', up: invoiceDedup.up, down: invoiceDedup.down },
  { name: '0018_payroll_tax', up: payrollTax.up, down: payrollTax.down },
  { name: '0019_email_plane', up: emailPlane.up, down: emailPlane.down },
  { name: '0020_connector_sync_state', up: connectorSyncState.up, down: connectorSyncState.down },
  { name: '0021_invoice_dedup_currency', up: invoiceDedupCurrency.up, down: invoiceDedupCurrency.down },
  { name: '0022_record_team_tags', up: recordTeamTags.up, down: recordTeamTags.down },
  { name: '0023_teams', up: teams.up, down: teams.down },
  { name: '0024_tags', up: tags.up, down: tags.down },
  { name: '0025_record_annotations', up: recordAnnotations.up, down: recordAnnotations.down },
  { name: '0026_connector_configs', up: connectorConfigs.up, down: connectorConfigs.down },
  { name: '0027_employee_user_binding', up: employeeUserBinding.up, down: employeeUserBinding.down },
  { name: '0028_identity_admin_surfaces', up: identityAdminSurfaces.up, down: identityAdminSurfaces.down },
  { name: '0029_rls_permissive_base', up: rlsPermissiveBase.up, down: rlsPermissiveBase.down },
  { name: '0030_event_outbox_rls_safe_tenant_cast', up: eventOutboxRlsSafeTenantCast.up, down: eventOutboxRlsSafeTenantCast.down },
  { name: '0031_audit_hash_canonicalization', up: auditHashCanonicalization.up, down: auditHashCanonicalization.down },
];
