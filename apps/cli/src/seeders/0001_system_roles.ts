import { type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { randomUUID as uuid } from 'node:crypto';
import { Permission, SystemRole, TableName } from '@aegis/shared-enums';
import { ALL_PERMISSIONS, ROLE_PERMS } from './rbac-catalog';

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  const now = new Date();

  const permId = new Map<Permission, string>();
  const permRows = ALL_PERMISSIONS.map((name) => {
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
