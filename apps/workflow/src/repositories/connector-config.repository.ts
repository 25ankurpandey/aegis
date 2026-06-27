import type { Transaction } from 'sequelize';
import type { ConnectorKind } from '@aegis/shared-enums';
import { WorkflowShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getWorkflowContext } from '../models/database-context';

/** Tenant-scoped data access for connector configuration and sync-state operator views. */
@provideSingleton(ConnectorConfigRepository)
export class ConnectorConfigRepository {
  async listConfigs(t: Transaction): Promise<WorkflowShape.ConnectorConfigRow[]> {
    const { ConnectorConfig } = getWorkflowContext();
    const rows = await ConnectorConfig.findAll({ order: [['kind', 'ASC']], transaction: t });
    return rows.map((r) => r.get({ plain: true }) as WorkflowShape.ConnectorConfigRow);
  }

  async findActiveConfigByKind(
    kind: ConnectorKind,
    t: Transaction,
  ): Promise<WorkflowShape.ConnectorConfigRow | null> {
    const { ConnectorConfig } = getWorkflowContext();
    const row = await ConnectorConfig.findOne({ where: { kind, active: true }, transaction: t });
    return row ? (row.get({ plain: true }) as WorkflowShape.ConnectorConfigRow) : null;
  }

  async upsertConfig(
    tenantId: string,
    kind: ConnectorKind,
    input: WorkflowShape.UpsertConnectorConfigInput,
    updatedBy: string | null,
    t: Transaction,
  ): Promise<WorkflowShape.ConnectorConfigRow> {
    const { ConnectorConfig } = getWorkflowContext();
    const existing = await ConnectorConfig.findOne({ where: { tenant_id: tenantId, kind }, transaction: t });
    const patch = {
      tenant_id: tenantId,
      kind,
      active: input.active ?? true,
      base_url: input.baseUrl ?? null,
      credentials_ref: input.credentialsRef ?? null,
      settings: input.settings ?? {},
      updated_by: updatedBy,
    };
    if (existing) {
      await existing.update(patch, { transaction: t });
      return existing.get({ plain: true }) as WorkflowShape.ConnectorConfigRow;
    }
    const row = await ConnectorConfig.create({ ...patch, created_by: updatedBy }, { transaction: t });
    return row.get({ plain: true }) as WorkflowShape.ConnectorConfigRow;
  }

  async listSyncState(
    opts: WorkflowShape.ListConnectorSyncStateInput,
    t: Transaction,
  ): Promise<{ rows: WorkflowShape.ConnectorSyncStateRow[]; total: number }> {
    const { ConnectorSyncState } = getWorkflowContext();
    const where: Record<string, unknown> = {};
    if (opts.kind) where['kind'] = opts.kind;
    if (opts.status) where['status'] = opts.status;
    const result = await ConnectorSyncState.findAndCountAll({
      where,
      order: [['created_at', 'DESC']],
      limit: opts.limit,
      offset: opts.offset,
      transaction: t,
    });
    return {
      rows: result.rows.map((r) => r.get({ plain: true }) as WorkflowShape.ConnectorSyncStateRow),
      total: result.count,
    };
  }

  async findSyncStateByIdempotencyKey(
    idempotencyKey: string,
    t: Transaction,
  ): Promise<WorkflowShape.ConnectorSyncStateRow | null> {
    const { ConnectorSyncState } = getWorkflowContext();
    const row = await ConnectorSyncState.findOne({ where: { idempotency_key: idempotencyKey }, transaction: t });
    return row ? (row.get({ plain: true }) as WorkflowShape.ConnectorSyncStateRow) : null;
  }

}
