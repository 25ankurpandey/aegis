import { ConnectorSyncStatus } from '@aegis/shared-enums';
import type { ConnectorKind, ConnectorEntity } from '@aegis/shared-enums';

/** Per-tenant connector configuration (stored in connector_configs; secrets via the secret proxy). */
export interface ConnectorConfig {
  kind: ConnectorKind;
  tenantId: string;
  baseUrl?: string;
  /** Name of the secret holding this connector's credentials (resolved by @aegis/service-core Secrets). */
  credentialsRef?: string;
  settings?: Record<string, unknown>;
}

export interface PushRequest {
  entity: ConnectorEntity;
  /** Required — guarantees a transaction is pushed at most once. */
  idempotencyKey: string;
  externalRefHint?: string;
  data: Record<string, unknown>;
}

export type SyncState = 'synced' | 'queued' | 'in_progress' | 'error';

/**
 * Map the {@link PushResult.status} string union onto the persisted {@link ConnectorSyncStatus} enum.
 * The two intentionally share wire values, so this is a checked identity — it exists so the durable
 * sync-state layer references the enum (one source of truth) without the connectors re-importing it.
 */
export function toSyncStatus(state: SyncState): ConnectorSyncStatus {
  return state as unknown as ConnectorSyncStatus;
}

export interface PushResult {
  accepted: boolean;
  externalId?: string;
  status: SyncState;
  message?: string;
  /** The ERP-specific payload the connector's transformer produced (for audit / debugging). */
  payload?: Record<string, unknown>;
}

export interface ConnectorStatusResult {
  externalId: string;
  status: SyncState;
  message?: string;
}

/**
 * The contract every ERP integration implements. A new ERP is added by writing ONE adapter that
 * implements this interface and registering it — see docs/services/connectors.md.
 */
export interface Connector {
  readonly kind: ConnectorKind;
  authenticate(config: ConnectorConfig): Promise<void>;
  pushTransaction(config: ConnectorConfig, req: PushRequest): Promise<PushResult>;
  getStatus(config: ConnectorConfig, externalId: string): Promise<ConnectorStatusResult>;
  healthCheck(config: ConnectorConfig): Promise<boolean>;
}
