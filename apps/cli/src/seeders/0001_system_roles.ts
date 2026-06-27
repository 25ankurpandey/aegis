import { type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { randomUUID as uuid } from 'node:crypto';
import { Permission, SystemRole, TableName } from '@aegis/shared-enums';

const ALL = Object.values(Permission);

/** Sensible default role → permission catalog for the seeded system roles. */
const ROLE_PERMS: Record<SystemRole, Permission[]> = {
  [SystemRole.Owner]: ALL,
  [SystemRole.Admin]: ALL,
  [SystemRole.Manager]: [
    Permission.UserView,
    Permission.RoleView,
    Permission.TeamManage,
    Permission.OrgManage,
    Permission.TagCreate,
    Permission.TagUpdate,
    Permission.TagDelete,
    Permission.TagList,
    Permission.RecordTagAdd,
    Permission.RecordTagRemove,
    Permission.RecordAssign,
    Permission.TeamTagManage,
    Permission.ExpenseReportView,
    Permission.ExpenseReportApprove,
    Permission.ExpenseReportReject,
    Permission.InvoiceView,
    Permission.InvoiceApprove,
    Permission.ReportRun,
    Permission.ReportView,
    Permission.AuditView,
  ],
  [SystemRole.Approver]: [
    Permission.ExpenseReportView,
    Permission.ExpenseReportApprove,
    Permission.ExpenseReportReject,
    Permission.InvoiceView,
    Permission.InvoiceApprove,
    Permission.TagList,
  ],
  [SystemRole.Contributor]: [
    Permission.ExpenseReportCreate,
    Permission.ExpenseReportView,
    Permission.ExpenseReportUpdate,
    Permission.ExpenseReportSubmit,
    Permission.InvoiceCreate,
    Permission.InvoiceView,
    Permission.InvoiceUpdate,
    Permission.TagList,
  ],
  [SystemRole.Viewer]: [
    Permission.ExpenseReportView,
    Permission.InvoiceView,
    Permission.ReportView,
    Permission.UserView,
    Permission.RoleView,
    Permission.TagList,
  ],
  [SystemRole.PayrollAdmin]: [
    Permission.PayrollEmployeeView,
    Permission.PayrollEmployeeManage,
    Permission.PayrollSensitiveRead,
    Permission.PayRunCreate,
    Permission.PayRunCalculate,
    Permission.PayslipViewAll,
    Permission.ConnectorManage,
    Permission.ConnectorPush,
    Permission.TagList,
  ],
  [SystemRole.PayrollApprover]: [
    Permission.PayrollEmployeeView,
    Permission.PayRunApprove,
    Permission.PayslipViewAll,
    Permission.TagList,
  ],
  [SystemRole.FinanceDisburser]: [
    Permission.PayRunDisburse,
    Permission.PayslipViewAll,
    Permission.ExpenseReportView,
    Permission.ExpenseReportReimburse,
    Permission.TagList,
  ],
  [SystemRole.Auditor]: [
    Permission.AuditView,
    Permission.UserView,
    Permission.RoleView,
    Permission.PermissionView,
    Permission.PolicyView,
    Permission.SessionView,
    Permission.ExpenseReportView,
    Permission.InvoiceView,
    Permission.ReportView,
    Permission.TagList,
  ],
  [SystemRole.Employee]: [
    Permission.ExpenseReportCreate,
    Permission.ExpenseReportView,
    Permission.ExpenseReportSubmit,
    Permission.PayslipViewOwn,
    Permission.TagList,
  ],
};

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const now = new Date();

  const permId = new Map<Permission, string>();
  const permRows = ALL.map((name) => {
    const id = uuid();
    permId.set(name, id);
    return { id, name, description: name, created_at: now, updated_at: now };
  });
  await q.bulkInsert(TableName.Permissions, permRows);

  const roleId = new Map<SystemRole, string>();
  const roleRows = Object.values(SystemRole).map((name) => {
    const id = uuid();
    roleId.set(name, id);
    return {
      id,
      tenant_id: null,
      name,
      description: `System role: ${name}`,
      is_system: true,
      created_at: now,
      updated_at: now,
    };
  });
  await q.bulkInsert(TableName.Roles, roleRows);

  const rpRows: Record<string, unknown>[] = [];
  for (const role of Object.values(SystemRole)) {
    for (const perm of ROLE_PERMS[role]) {
      rpRows.push({
        id: uuid(),
        role_id: roleId.get(role),
        permission_id: permId.get(perm),
        created_at: now,
        updated_at: now,
      });
    }
  }
  await q.bulkInsert(TableName.RolePermissions, rpRows);
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.bulkDelete(TableName.RolePermissions, {});
  await q.bulkDelete(TableName.Roles, { is_system: true });
  await q.bulkDelete(TableName.Permissions, {});
}
