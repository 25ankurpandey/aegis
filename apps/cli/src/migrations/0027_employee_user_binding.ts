import { DataTypes, Op, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { TableName } from '@aegis/shared-enums';

const TABLE = TableName.Employees;

/** Bind payroll employees to identity users so `payroll.payslip.view.own` has a real authority key. */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.addColumn(TABLE, 'user_id', {
    type: DataTypes.UUID,
    allowNull: true,
    references: { model: TableName.Users, key: 'id' },
    onDelete: 'SET NULL',
  });

  await q.addIndex(TABLE, ['tenant_id', 'user_id'], {
    unique: true,
    name: 'employees_tenant_user_uq',
    where: { user_id: { [Op.ne]: null } },
  });
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.removeIndex(TABLE, 'employees_tenant_user_uq');
  await q.removeColumn(TABLE, 'user_id');
}
