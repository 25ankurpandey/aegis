import { inject } from 'inversify';
import { ErrUtils, RequestContext } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import { ConnectorRegistry } from '@aegis/connectors';
import { ConnectorKind } from '@aegis/shared-enums';
import { PaginationConstants } from '@aegis/shared-constants';
import { WorkflowShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { ConnectorConfigRepository } from '../repositories/connector-config.repository';
import { reconcilePending } from '../consumers/connector-sync.consumer';
import { DbSyncStateStore } from './connector-sync-state.store';

/** Operator-facing connector config, health, and sync-state service. */
@provideSingleton(ConnectorAdminService)
export class ConnectorAdminService {
  constructor(@inject(ConnectorConfigRepository) private readonly repo: ConnectorConfigRepository) {}

  async listConfigs(): Promise<{ data: WorkflowShape.ConnectorConfigDto[] }> {
    return withTenantTransaction(async (t) => ({
      data: (await this.repo.listConfigs(t)).map((row) => this.toConfigDto(row)),
    }));
  }

  async upsertConfig(
    kind: ConnectorKind,
    input: WorkflowShape.UpsertConnectorConfigInput,
  ): Promise<WorkflowShape.ConnectorConfigDto> {
    const tenantId = RequestContext.tenantId();
    const actorId = RequestContext.userId() ?? null;
    if (!ConnectorRegistry.list().includes(kind)) {
      throw ErrUtils.validation(`Connector kind '${kind}' is not registered`);
    }
    return withTenantTransaction(async (t) =>
      this.toConfigDto(await this.repo.upsertConfig(tenantId, kind, input, actorId, t)),
    );
  }

  async health(kind: ConnectorKind): Promise<WorkflowShape.ConnectorHealthDto> {
    return withTenantTransaction(async (t) => {
      const row = await this.repo.findActiveConfigByKind(kind, t);
      if (!row) throw ErrUtils.notFound(`Active connector config not found for '${kind}'`);
      const ok = await ConnectorRegistry.get(kind).healthCheck({
        kind,
        tenantId: row.tenant_id,
        ...(row.base_url ? { baseUrl: row.base_url } : {}),
        ...(row.credentials_ref ? { credentialsRef: row.credentials_ref } : {}),
        settings: row.settings ?? {},
      });
      return { kind, healthy: ok };
    });
  }

  async listSyncState(
    input: WorkflowShape.ConnectorSyncStateQuery,
  ): Promise<WorkflowShape.ConnectorSyncStateListResult> {
    const page = Math.max(input.page ?? PaginationConstants.DefaultPage, 1);
    const pageSize = Math.min(
      Math.max(input.pageSize ?? PaginationConstants.DefaultPageSize, 1),
      PaginationConstants.MaxPageSize,
    );
    return withTenantTransaction(async (t) => {
      const { rows, total } = await this.repo.listSyncState(
        { kind: input.kind, status: input.status, limit: pageSize, offset: (page - 1) * pageSize },
        t,
      );
      return { data: rows.map((row) => this.toSyncDto(row)), meta: { total, page, pageSize } };
    });
  }

  async getSyncState(idempotencyKey: string): Promise<WorkflowShape.ConnectorSyncStateDto> {
    return withTenantTransaction(async (t) => {
      const row = await this.repo.findSyncStateByIdempotencyKey(idempotencyKey, t);
      if (!row) throw ErrUtils.notFound('Connector sync-state row not found');
      return this.toSyncDto(row);
    });
  }

  async reconcile(
    input: WorkflowShape.ConnectorReconcileInput,
  ): Promise<WorkflowShape.ConnectorReconcileResult> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const advanced = await reconcilePending(new DbSyncStateStore(), limit);
    return { data: { limit, advanced } };
  }

  private toConfigDto(row: WorkflowShape.ConnectorConfigRow): WorkflowShape.ConnectorConfigDto {
    return {
      id: row.id,
      kind: row.kind,
      active: row.active,
      baseUrl: row.base_url,
      credentialsRef: row.credentials_ref,
      settings: row.settings ?? {},
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private toSyncDto(row: WorkflowShape.ConnectorSyncStateRow): WorkflowShape.ConnectorSyncStateDto {
    return {
      id: row.id,
      kind: row.kind,
      entity: row.entity,
      recordId: row.record_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      externalId: row.external_id,
      attempts: row.attempts,
      lastError: row.last_error,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
