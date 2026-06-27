import { DataTypes, Op, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import {
  EmailNotificationStatus,
  EmailSuppressionReason,
  TableName,
} from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

/**
 * Production email-plane storage (G2/G3/G8 — see docs/analysis/EMAIL_alignment.md):
 *
 *  - `email_sender_identities` — ONE row per tenant carrying the per-tenant sender identity
 *    (from_name / from_email / reply_to) AND the email master-switch (`email_enabled`). The absence
 *    of a row means: master-switch ON (default-send) and the provider's configured default From.
 *
 *  - `email_suppressions` (TableName.EmailSuppressions) — a tenant-scoped suppression list
 *    (address, reason bounce|complaint|unsubscribe, source) checked in `EmailSenderService` BEFORE
 *    `provider.send`; a hit records the ledger row as `Suppressed`. Inbound bounce/complaint
 *    ingestion (the webhook that POPULATES this table) is a documented follow-up; the table + the
 *    pre-send check land here.
 *
 * Both tables are tenant-scoped with FORCE + RESTRICTIVE Row-Level Security keyed on
 * app.current_tenant, mirroring 0006/0010/0014, so an identity/suppression can never leak across
 * tenants. (`email_sender_identities` is not in the shared TableName enum — it is a notification-
 * service-local table — so its name is a local literal here; RLS/createTable take a plain string.)
 */

/** notification-service-local table (no shared TableName entry — see header). */
const SENDER_IDENTITIES_TABLE = 'email_sender_identities';

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

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // --- Per-tenant sender identity + email master-switch (G2/G3) ---
  await q.createTable(SENDER_IDENTITIES_TABLE, {
    id: uuidPk,
    tenant_id: tenantFk,
    from_name: { type: DataTypes.STRING, allowNull: true },
    from_email: { type: DataTypes.STRING, allowNull: true },
    reply_to: { type: DataTypes.STRING, allowNull: true },
    // Tenant email master-switch — false hard-disables ALL outbound email for the tenant.
    email_enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ...timestamps,
  });
  // Exactly one identity row per tenant (the resolver reads at most one).
  await q.addIndex(SENDER_IDENTITIES_TABLE, ['tenant_id'], {
    unique: true,
    name: 'email_sender_identities_tenant_uq',
  });

  // --- Suppression list (G8) ---
  await q.createTable(TableName.EmailSuppressions, {
    id: uuidPk,
    tenant_id: tenantFk,
    // Normalized (lower-cased) recipient address.
    address: { type: DataTypes.STRING, allowNull: false },
    reason: { type: DataTypes.STRING, allowNull: false },
    // Free-form origin (e.g. sns-bounce | manual | unsubscribe-link); nullable.
    source: { type: DataTypes.STRING, allowNull: true },
    // Append-only ledger — only created_at (no updated_at): an entry is added or removed, never edited.
    created_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: Sequelize.literal('now()'),
    },
  });
  // At most one suppression per (tenant, address); the pre-send check is a point lookup on this.
  await q.addIndex(TableName.EmailSuppressions, ['tenant_id', 'address'], {
    unique: true,
    name: 'email_suppressions_tenant_address_uq',
  });
  // `reason` is drawn from the EmailSuppressionReason set.
  await q.addConstraint(TableName.EmailSuppressions, {
    type: 'check',
    fields: ['reason'],
    name: 'email_suppressions_reason_chk',
    where: { reason: { [Op.in]: Object.values(EmailSuppressionReason) } },
  });

  // --- Richer terminal-status vocabulary (G4) ---
  // 0006 stamped a CHECK allowing only pending|sent|failed. The email plane now records policy
  // not-sent states (suppressed|disabled|blocked) distinct from a transport failure, so widen the
  // constraint to the full EmailNotificationStatus set. Drop-then-add keeps it value-driven (the
  // enum is the single source of truth) and reversible in `down`.
  await q.removeConstraint(TableName.EmailNotificationLogs, 'email_notification_logs_status_chk');
  await q.addConstraint(TableName.EmailNotificationLogs, {
    type: 'check',
    fields: ['status'],
    name: 'email_notification_logs_status_chk',
    where: { status: { [Op.in]: Object.values(EmailNotificationStatus) } },
  });

  // Row-Level Security (FORCE + RESTRICTIVE on tenant_id) for both new tables.
  const stmts = [
    ...rlsPolicyStatements(SENDER_IDENTITIES_TABLE),
    ...rlsPolicyStatements(TableName.EmailSuppressions),
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  // Restore the original (pre-email-plane) status CHECK — pending|sent|failed only. Any rows in a
  // policy state must be reconciled before a down-migration; the narrower constraint reasserts 0006.
  await q.removeConstraint(TableName.EmailNotificationLogs, 'email_notification_logs_status_chk');
  await q.addConstraint(TableName.EmailNotificationLogs, {
    type: 'check',
    fields: ['status'],
    name: 'email_notification_logs_status_chk',
    where: {
      status: {
        [Op.in]: [
          EmailNotificationStatus.Pending,
          EmailNotificationStatus.Sent,
          EmailNotificationStatus.Failed,
        ],
      },
    },
  });

  await q.dropTable(TableName.EmailSuppressions);
  await q.dropTable(SENDER_IDENTITIES_TABLE);
}
