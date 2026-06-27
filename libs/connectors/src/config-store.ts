import { ConnectorKind } from '@aegis/shared-enums';
import { ErrUtils } from '@aegis/service-core';
import type { ConnectorConfig } from './connector';

/**
 * Per-ERP config/auth seam (docs/analysis/ERP_proxy_alignment.md §4 item 2). The consumer's stub
 * `configFor(kind, tenantId)` returned `{ kind, tenantId }` with no baseUrl / credentialsRef / settings,
 * so no real (non-mock) ERP could resolve its own endpoint or secret. This formalizes resolution so
 * each {@link ConnectorKind} loads its OWN per-tenant config — mirroring the donor's per-connection
 * `Credentials`/`SyncSettings` lookup, minus the encrypted store (secrets resolve through the existing
 * @aegis/service-core secret proxy via {@link ConnectorConfig.credentialsRef}, never inlined here).
 *
 * Like {@link SyncStateStore} this is an INTERFACE so the lib stays db-agnostic: the workflow app binds
 * a `connector_configs`-backed implementation; tests and mocks use {@link StaticConnectorConfigStore}.
 */
export interface ConnectorConfigStore {
  /** Resolve the connector config for one (tenant, kind). Throws if the ERP is not configured. */
  resolve(kind: ConnectorKind, tenantId: string): Promise<ConnectorConfig>;
}

/**
 * Default store: returns a minimal `{ kind, tenantId }` config (optionally merged with a per-kind
 * default), which is exactly what the mock connectors need. Production overrides this with a
 * `connector_configs`-backed store that adds `baseUrl` / `credentialsRef` / `settings` per tenant.
 *
 * This preserves the previous `configFor` behaviour for mocks while giving real ERPs a single seam to
 * resolve their own auth — `BaseConnector.authenticate(config)` is the token-handshake hook that a real
 * connector overrides (the donor's `CredentialRefreshManager` token-refresh-on-401 lives there).
 */
export class StaticConnectorConfigStore implements ConnectorConfigStore {
  constructor(private readonly defaults: Partial<Record<ConnectorKind, Partial<ConnectorConfig>>> = {}) {}

  async resolve(kind: ConnectorKind, tenantId: string): Promise<ConnectorConfig> {
    if (!Object.values(ConnectorKind).includes(kind)) {
      throw ErrUtils.system(`No connector config resolvable for kind '${kind}'`);
    }
    return { ...(this.defaults[kind] ?? {}), kind, tenantId };
  }
}
