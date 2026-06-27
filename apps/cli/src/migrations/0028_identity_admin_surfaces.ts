import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import { InviteStatus, Scope, SessionStatus, TableName } from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

const uuidPk = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: Sequelize.literal('gen_random_uuid()'),
};

const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
};

const tenantFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Tenants, key: 'id' },
  onDelete: 'CASCADE',
};

function inList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

/** Backing tables for the user-management admin surfaces documented in BUG-0015. */
export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TableName.Policies, {
    id: uuidPk,
    tenant_id: tenantFk,
    permission: { type: DataTypes.STRING, allowNull: false },
    effect: { type: DataTypes.STRING, allowNull: false, defaultValue: 'allow' },
    rule: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    created_by: { type: DataTypes.UUID, allowNull: true },
    updated_by: { type: DataTypes.UUID, allowNull: true },
    deleted_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  });
  await q.addIndex(TableName.Policies, ['tenant_id', 'permission'], { name: 'policies_tenant_permission_idx' });
  await q.addIndex(TableName.Policies, ['tenant_id', 'priority'], { name: 'policies_tenant_priority_idx' });
  await q.addConstraint(TableName.Policies, {
    type: 'check',
    name: 'policies_effect_chk',
    fields: ['effect'],
    where: Sequelize.literal('"effect" IN (\'allow\', \'deny\')'),
  });

  await q.createTable(TableName.Invites, {
    id: uuidPk,
    tenant_id: tenantFk,
    email: { type: DataTypes.STRING, allowNull: false },
    token_hash: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: InviteStatus.Pending },
    role_id: {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: TableName.Roles, key: 'id' },
      onDelete: 'SET NULL',
    },
    scope: { type: DataTypes.STRING, allowNull: false, defaultValue: Scope.OwnOnly },
    team_ids: { type: DataTypes.ARRAY(DataTypes.UUID), allowNull: false, defaultValue: [] },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    accepted_at: { type: DataTypes.DATE, allowNull: true },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    created_by: { type: DataTypes.UUID, allowNull: true },
    ...timestamps,
  });
  await q.addIndex(TableName.Invites, ['tenant_id', 'email'], { name: 'invites_tenant_email_idx' });
  await q.addIndex(TableName.Invites, ['token_hash'], { unique: true, name: 'invites_token_hash_uq' });
  await q.addConstraint(TableName.Invites, {
    type: 'check',
    name: 'invites_status_chk',
    fields: ['status'],
    where: Sequelize.literal(`"status" IN (${inList(Object.values(InviteStatus))})`),
  });
  await q.addConstraint(TableName.Invites, {
    type: 'check',
    name: 'invites_scope_chk',
    fields: ['scope'],
    where: Sequelize.literal(`"scope" IN (${inList(Object.values(Scope))})`),
  });

  await q.createTable(TableName.Sessions, {
    id: uuidPk,
    tenant_id: tenantFk,
    user_id: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: TableName.Users, key: 'id' },
      onDelete: 'CASCADE',
    },
    jti: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: SessionStatus.Active },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    revoked_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps,
  });
  await q.addIndex(TableName.Sessions, ['tenant_id', 'user_id'], { name: 'sessions_tenant_user_idx' });
  await q.addIndex(TableName.Sessions, ['jti'], { unique: true, name: 'sessions_jti_uq' });
  await q.addConstraint(TableName.Sessions, {
    type: 'check',
    name: 'sessions_status_chk',
    fields: ['status'],
    where: Sequelize.literal(`"status" IN (${inList(Object.values(SessionStatus))})`),
  });

  for (const stmt of [
    ...rlsPolicyStatements(TableName.Policies),
    ...rlsPolicyStatements(TableName.Invites),
    ...rlsPolicyStatements(TableName.Sessions),
  ]) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.Sessions);
  await q.dropTable(TableName.Invites);
  await q.dropTable(TableName.Policies);
}
