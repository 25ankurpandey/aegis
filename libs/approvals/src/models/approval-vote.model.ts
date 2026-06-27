import { DataTypes, type ModelStatic, type Model } from 'sequelize';
import type { ModelRegistry } from '@aegis/db';
import { TableName, ApprovalDecision } from '@aegis/shared-enums';

/**
 * Defines the `approvals` table — the immutable, append-only vote ledger. One row per recorded
 * decision `(record, level, approver) → decision`, with `decided_at` and an optional `comment`.
 * Append-only: `created_at` only, no `updated_at` (a vote is never mutated; a rejection
 * short-circuits the chain instead) — so it is defined directly on the connection (like the audit
 * log) and `register`ed with the registry, rather than going through the shared base options that
 * always add `updated_at`. Tenant-scoped + RLS. The DB enforces one vote per
 * `(tenant, record, level, approver)` via a unique index (the no-double-vote invariant).
 */
export function defineApprovalVote(registry: ModelRegistry): ModelStatic<Model> {
  const model = registry.connection.define(
    TableName.Approvals,
    {
      id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
      tenant_id: { type: DataTypes.UUID, allowNull: false },
      record_type: { type: DataTypes.STRING, allowNull: false },
      record_id: { type: DataTypes.UUID, allowNull: false },
      level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
      approver_id: { type: DataTypes.UUID, allowNull: false },
      decision: { type: DataTypes.STRING, allowNull: false, defaultValue: ApprovalDecision.Approved },
      comment: { type: DataTypes.TEXT, allowNull: true },
      decided_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    },
    {
      tableName: TableName.Approvals,
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: false, // append-only ledger
    },
  );
  return registry.register(model);
}
