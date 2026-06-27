import { UniqueConstraintError, type Model, type ModelStatic, type Transaction } from 'sequelize';
import { withTenantTransaction } from '@aegis/db';
import { ConnectorSyncStatus, type ConnectorEntity, type ConnectorKind } from '@aegis/shared-enums';
import type {
  SyncStateOutcome,
  SyncStateRecord,
  SyncStateStore,
} from '@aegis/connectors';
import { getWorkflowContext } from '../models/database-context';

/**
 * Postgres-backed, RLS-scoped {@link SyncStateStore} over `connector_sync_state` (migration 0020). This
 * is the production binding the analysis asks for (ERP_proxy_alignment §4 item 1): BaseConnector's
 * idempotency + attempt accounting become DURABLE — surviving worker restarts, replica fan-out, and
 * Kafka rebalances that the previous in-memory Map could not. Every method runs inside
 * `withTenantTransaction`, so the tenant-isolation RLS policy on the table is always in effect.
 *
 * Bound into the connectors at workflow bootstrap (see bootstrap.ts) via `connector.useSyncStateStore`.
 */
export class DbSyncStateStore implements SyncStateStore {
  private model(): ModelStatic<Model> {
    return getWorkflowContext().ConnectorSyncState;
  }

  /** Map a Sequelize row to the lib's plain record shape. */
  private toRecord(row: Model): SyncStateRecord {
    const r = row.get({ plain: true }) as Record<string, unknown>;
    return {
      tenantId: r['tenant_id'] as string,
      kind: r['kind'] as ConnectorKind,
      entity: r['entity'] as ConnectorEntity,
      recordId: r['record_id'] as string,
      idempotencyKey: r['idempotency_key'] as string,
      status: r['status'] as ConnectorSyncStatus,
      externalId: (r['external_id'] as string | null) ?? undefined,
      attempts: r['attempts'] as number,
      lastError: (r['last_error'] as string | null) ?? undefined,
    };
  }

  async upsertQueued(
    seed: Omit<SyncStateRecord, 'status' | 'attempts'>,
  ): Promise<{ record: SyncStateRecord; existed: boolean }> {
    return withTenantTransaction(async (t) => {
      const Model = this.model();
      try {
        const created = await Model.create(
          {
            tenant_id: seed.tenantId,
            kind: seed.kind,
            entity: seed.entity,
            record_id: seed.recordId,
            idempotency_key: seed.idempotencyKey,
            status: ConnectorSyncStatus.InProgress,
            external_id: seed.externalId ?? null,
            attempts: 0,
          },
          { transaction: t },
        );
        return { record: this.toRecord(created), existed: false };
      } catch (err) {
        // Lost the insert race (concurrent redelivery) — the unique (tenant_id, idempotency_key) index
        // rejected the duplicate. Read the winner's row so the caller returns ITS outcome (no re-push).
        if (err instanceof UniqueConstraintError) {
          const existing = await this.findInTx(t, seed.tenantId, seed.idempotencyKey);
          if (existing) return { record: existing, existed: true };
        }
        throw err;
      }
    });
  }

  async recordOutcome(
    key: { tenantId: string; idempotencyKey: string },
    outcome: SyncStateOutcome,
  ): Promise<SyncStateRecord> {
    return withTenantTransaction(async (t) => {
      const Model = this.model();
      const row = await Model.findOne({
        where: { tenant_id: key.tenantId, idempotency_key: key.idempotencyKey },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!row) throw new Error(`sync-state row not found for ${key.idempotencyKey}`);
      const current = this.toRecord(row);
      await row.update(
        {
          status: outcome.status,
          ...(outcome.externalId !== undefined ? { external_id: outcome.externalId } : {}),
          attempts: current.attempts + (outcome.attemptDelta ?? 0),
          last_error: outcome.lastError ?? null,
        },
        { transaction: t },
      );
      return this.toRecord(row);
    });
  }

  async find(key: { tenantId: string; idempotencyKey: string }): Promise<SyncStateRecord | null> {
    return withTenantTransaction((t) => this.findInTx(t, key.tenantId, key.idempotencyKey));
  }

  private async findInTx(t: Transaction, tenantId: string, idempotencyKey: string): Promise<SyncStateRecord | null> {
    const row = await this.model().findOne({
      where: { tenant_id: tenantId, idempotency_key: idempotencyKey },
      transaction: t,
    });
    return row ? this.toRecord(row) : null;
  }

  async listReconcilable(limit = 100): Promise<SyncStateRecord[]> {
    return withTenantTransaction(async (t) => {
      const rows = await this.model().findAll({
        where: { status: [ConnectorSyncStatus.Queued, ConnectorSyncStatus.InProgress] },
        order: [['created_at', 'ASC']],
        limit,
        transaction: t,
      });
      return rows.map((r) => this.toRecord(r));
    });
  }
}
