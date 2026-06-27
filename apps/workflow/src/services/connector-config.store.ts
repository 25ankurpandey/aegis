import { ErrUtils, RequestContext } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import type { ConnectorConfig, ConnectorConfigStore } from '@aegis/connectors';
import type { ConnectorKind } from '@aegis/shared-enums';
import { ConnectorConfigRepository } from '../repositories/connector-config.repository';

/**
 * DB-backed connector config resolver. Production calls this from the connector worker before each
 * push. A fallback store can be supplied for local mock demos; without it, missing config fails closed.
 */
export class DbConnectorConfigStore implements ConnectorConfigStore {
  private readonly repo = new ConnectorConfigRepository();

  constructor(private readonly fallback?: ConnectorConfigStore) {}

  async resolve(kind: ConnectorKind, tenantId: string): Promise<ConnectorConfig> {
    const ctxTenant = RequestContext.tenantId();
    if (ctxTenant !== tenantId) {
      throw ErrUtils.forbidden('Connector config tenant does not match request context');
    }

    const row = await withTenantTransaction((t) => this.repo.findActiveConfigByKind(kind, t));
    if (!row) {
      if (this.fallback) return this.fallback.resolve(kind, tenantId);
      throw ErrUtils.notFound(`Active connector config not found for '${kind}'`);
    }

    return {
      kind,
      tenantId: row.tenant_id,
      ...(row.base_url ? { baseUrl: row.base_url } : {}),
      ...(row.credentials_ref ? { credentialsRef: row.credentials_ref } : {}),
      settings: row.settings ?? {},
    };
  }
}
