import { Logger, RequestContext } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import {
  getBus,
  EventTopic,
  type EventEnvelope,
  type ConnectorPushRequestedPayload,
} from '@aegis/events';
import {
  BaseConnector,
  ConnectorRegistry,
  StaticConnectorConfigStore,
  type ConnectorConfig,
  type ConnectorConfigStore,
  type PushRequest,
  type PushResult,
  type SyncStateStore,
} from '@aegis/connectors';
import { DbSyncStateStore } from '../services/connector-sync-state.store';
import { AuditLogger } from '@aegis/audit';
import {
  AuditAction,
  AuditOutcome,
  ConnectorEntity,
  ConnectorKind,
} from '@aegis/shared-enums';

/**
 * ERP-sync consumer (W2-07). Invoice approval and pay-run disbursement used to call
 * `ConnectorRegistry.get(kind).pushTransaction(...)` SYNCHRONOUSLY in the request path, so a slow or
 * failing ERP blocked the user's request and a failure was never retried. Those producers now stage a
 * `ConnectorPushRequested` event in the SAME transaction as the approval/disbursement write (via the
 * transactional outbox), and this consumer performs the actual push OFF the request path.
 *
 * Reliability: the bus rebuilds the producer's RequestContext (tenant + correlation id) before each
 * handler, retries a failing handler up to `KAFKA_RETRY_MAX`, and DEAD-LETTERS the envelope on
 * exhaustion — so a transient ERP outage is retried and a permanent failure is parked for inspection
 * rather than silently lost.
 *
 * Idempotency: the push carries the producer's stable `idempotencyKey` (the invoice/pay-run id), and
 * BaseConnector pushes at most once per key — so a redelivery (at-least-once from the outbox relay or
 * a Kafka rebalance) is a no-op that returns the first result instead of double-pushing to the ERP.
 */

/**
 * The per-ERP config/auth seam (ERP_proxy_alignment §4 item 2). Defaults to the static store (minimal
 * `{ kind, tenantId }` — what the mock connectors need); a real deployment binds a `connector_configs`-
 * backed store via {@link bindConnectorStores} so each ConnectorKind resolves its own baseUrl /
 * credentialsRef / settings per tenant.
 */
let configStore: ConnectorConfigStore = new StaticConnectorConfigStore();

/** Resolve the connector config for a (tenant, kind) through the configured config store. */
function configFor(kind: ConnectorKind, tenantId: string): Promise<ConnectorConfig> {
  return configStore.resolve(kind, tenantId);
}

/**
 * Wire the DURABLE sync-state store into every registered connector and (optionally) swap the config
 * store. Called once at worker bootstrap so BaseConnector's idempotency + attempt accounting persist to
 * Postgres (`connector_sync_state`) instead of a per-process Map — closing the cross-restart / cross-
 * replica double-push gap (ERP_proxy_alignment §4 item 1). Defaults to a fresh {@link DbSyncStateStore}.
 */
export function bindConnectorStores(opts: { syncState?: SyncStateStore; config?: ConnectorConfigStore } = {}): void {
  const syncState = opts.syncState ?? new DbSyncStateStore();
  if (opts.config) configStore = opts.config;
  let bound = 0;
  for (const kind of ConnectorRegistry.list()) {
    const connector = ConnectorRegistry.get(kind);
    if (connector instanceof BaseConnector) {
      connector.useSyncStateStore(syncState);
      bound += 1;
    }
  }
  Logger.info('connector durable sync-state bound', { connectors: bound });
}

/** Anti-ambient-authority guard: the rebuilt context tenant MUST match the envelope's own tenant. */
function assertEnvelopeTenant(env: EventEnvelope): string {
  const ctxTenant = RequestContext.tenantId(); // throws if no scope — fail-closed
  if (!env.tenantId || env.tenantId !== ctxTenant) {
    throw new Error('event tenant does not match propagated context tenant');
  }
  return ctxTenant;
}

/**
 * Perform the ERP push for one ConnectorPushRequested event. Idempotent: BaseConnector dedupes on
 * `idempotencyKey`, so a redelivery returns the first push's result without re-hitting the ERP. The
 * push outcome is recorded to the append-only audit trail (best-effort: an audit-write failure is
 * logged but does NOT fail the handler, so it never causes an endless redeliver of a push that the
 * ERP already accepted).
 */
export async function pushFromEvent(
  env: EventEnvelope<ConnectorPushRequestedPayload>,
): Promise<PushResult> {
  const tenantId = assertEnvelopeTenant(env);
  const payload = env.payload;

  const kind = (payload.connectorKind as ConnectorKind) ?? ConnectorKind.LedgerOne;
  const entity = (payload.entity as ConnectorEntity) ?? ConnectorEntity.Invoice;

  const req: PushRequest = {
    entity,
    idempotencyKey: payload.idempotencyKey,
    externalRefHint: payload.recordId,
    data: payload.data ?? {},
  };

  // Idempotent push: at most once per idempotencyKey, enforced DURABLY by the sync-state store
  // (redelivery across restarts/replicas → recorded first result, no re-push to the ERP).
  const config = await configFor(kind, tenantId);
  const result = await ConnectorRegistry.get(kind).pushTransaction(config, req);

  await recordPushOutcome(payload, result);

  Logger.info('connector.sync.pushed', {
    kind,
    entity,
    idempotencyKey: payload.idempotencyKey,
    recordType: payload.recordType,
    recordId: payload.recordId,
    status: result.status,
    accepted: result.accepted,
  });

  return result;
}

/** Write the push outcome to the audit/activity trail. Best-effort: never fails the handler. */
async function recordPushOutcome(
  payload: ConnectorPushRequestedPayload,
  result: PushResult,
): Promise<void> {
  try {
    await withTenantTransaction((t) =>
      AuditLogger.record(
        {
          action: AuditAction.RecordUpdated,
          outcome: result.accepted ? AuditOutcome.Success : AuditOutcome.Failure,
          resourceType: payload.recordType,
          resourceId: payload.recordId,
          details: {
            connectorKind: payload.connectorKind,
            entity: payload.entity,
            idempotencyKey: payload.idempotencyKey,
            externalId: result.externalId,
            status: result.status,
            ruleId: payload.ruleId,
          },
        },
        t,
      ),
    );
  } catch (err) {
    // Audit is best-effort here: the ERP push already (idempotently) succeeded/failed and must not be
    // redelivered just because the trail write failed. Surface it for forensics instead of throwing.
    Logger.error(err as Error, 'CONNECTOR_SYNC_AUDIT', payload.recordType, {
      idempotencyKey: payload.idempotencyKey,
    });
  }
}

/**
 * STATUS-CALLBACK RECONCILE (ERP_proxy_alignment §4 item 3). Drive every non-terminal
 * (`queued`/`in_progress`) sync-state row toward a terminal status by polling the ERP — the donor's
 * status-poll cron. A scheduled job (per-tenant context already set) calls this so a push the ERP
 * accepted asynchronously is eventually resolved; without it a `queued` row never settles. Reconcile
 * failures are isolated per-row (one bad ERP response must not abort the whole sweep) and surfaced for
 * forensics. Returns the number of rows whose status actually changed.
 *
 * The store is RLS-scoped, so `listReconcilable()` only returns the CURRENT tenant's rows — run this
 * inside the tenant's request/transaction context (e.g. `withTenantTransaction`'s scope).
 */
export async function reconcilePending(store: SyncStateStore, limit = 100): Promise<number> {
  const rows = await store.listReconcilable(limit);
  let advanced = 0;
  for (const row of rows) {
    try {
      const connector = ConnectorRegistry.get(row.kind);
      if (!(connector instanceof BaseConnector)) continue;
      connector.useSyncStateStore(store);
      const config = await configFor(row.kind, row.tenantId);
      const before = row.status;
      const after = await connector.reconcile(config, row);
      if (after && after !== before) advanced += 1;
    } catch (err) {
      Logger.error(err as Error, 'CONNECTOR_RECONCILE', row.entity, {
        kind: row.kind,
        idempotencyKey: row.idempotencyKey,
      });
    }
  }
  Logger.info('connector.reconcile.sweep', { scanned: rows.length, advanced });
  return advanced;
}

/** Handler bound to the bus: lets a push failure propagate so the bus retries → dead-letters. */
async function onConnectorPushRequested(
  env: EventEnvelope<ConnectorPushRequestedPayload>,
): Promise<void> {
  await pushFromEvent(env);
}

/**
 * Subscribe the ERP-sync consumer to ConnectorPushRequested. Called from the workflow worker's
 * `registerConsumers()` so the push runs in the worker role (the consumer half), never in an API
 * request. A push failure propagates out of the handler so the bus's bounded retry + DLQ engage.
 */
export function registerConnectorSyncConsumer(): void {
  const bus = getBus();
  bus.subscribe(EventTopic.ConnectorPushRequested, onConnectorPushRequested);
  Logger.info('connector-sync consumer registered', { topic: EventTopic.ConnectorPushRequested });
}
