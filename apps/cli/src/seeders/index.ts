import type { MigrationModule } from '@aegis/db';
import * as systemRoles from './0001_system_roles';
import * as demoTenant from './0002_demo_tenant';
import * as casbinPolicies from './0003_casbin_policies';
import * as approvalPolicies from './0004_approval_policies';
import * as demoTenantB from './0005_demo_tenant_b';
import * as connectorConfigs from './0006_connector_configs';

/** Ordered list of data seeders (system roles + base permission catalog, demo tenant, etc.). */
export const seeders: MigrationModule[] = [
  { name: '0001_system_roles', up: systemRoles.up, down: systemRoles.down },
  { name: '0002_demo_tenant', up: demoTenant.up, down: demoTenant.down },
  // After roles/permissions/role_permissions + the demo user_role exist, project them into casbin_rules.
  { name: '0003_casbin_policies', up: casbinPolicies.up, down: casbinPolicies.down },
  // Shared default approval policies for the demo tenant — one row per approvable record type
  // (expense_report / invoice / pay_run), so the engine routes all three after dev-up.
  { name: '0004_approval_policies', up: approvalPolicies.up, down: approvalPolicies.down },
  // A second real tenant (Demo Org B) so cross-tenant RLS isolation is push-button in the live E2E.
  // Self-contained (creates its own casbin g-rule); runs last so it tops up after 0003 reseeds.
  { name: '0005_demo_tenant_b', up: demoTenantB.up, down: demoTenantB.down },
  // Neutral mock ERP connector bindings for both demo tenants.
  { name: '0006_connector_configs', up: connectorConfigs.up, down: connectorConfigs.down },
];
