import { ConnectorSyncStatus, type ConnectorKind } from '@aegis/shared-enums';
import { Logger } from '@aegis/service-core';
import {
  toSyncStatus,
  type Connector,
  type ConnectorConfig,
  type ConnectorStatusResult,
  type PushRequest,
  type PushResult,
} from './connector';
import { IdentityTransformer, type ErpPayload, type Transformer } from './transformer';
import { isRetryable } from './errors';
import {
  InMemorySyncStateStore,
  type SyncStateRecord,
  type SyncStateStore,
} from './sync-state';

/**
 * Exponential-backoff retry that respects the typed connector error hierarchy: an
 * {@link UnrecoverableError} short-circuits the loop (no point retrying a bad payload / "period
 * closed"), while a {@link RetryableError} — or any untyped throw (fail-OPEN) — is retried up to
 * `retries` times with `baseDelayMs * 2^attempt` backoff. Tracks how many ERP calls were actually made
 * so the caller can persist the attempt count to durable sync-state.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 50,
): Promise<{ value: T; attempts: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const value = await fn();
      return { value, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      // Permanent failure: stop immediately, do NOT burn the remaining budget (donor UnrecoverableException).
      if (!isRetryable(err) || attempt >= retries) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastErr;
}

/**
 * Process-global default store for the mock connectors so a redelivery to the SAME process is deduped
 * out of the box. Production binds a Postgres-backed {@link SyncStateStore} via
 * {@link BaseConnector.useSyncStateStore} (durable across restarts / replicas).
 */
const defaultStore = new InMemorySyncStateStore();

/**
 * Base for all connectors: enforces DURABLE idempotency (push at most once per key — persisted to the
 * sync-state store, not an in-memory Map that dies on restart / can't span replicas), typed
 * retry/backoff, attempt + error accounting, and audits every outbound call. Subclasses implement
 * `doPush` / `doStatus` for the specific ERP.
 */
export abstract class BaseConnector implements Connector {
  abstract readonly kind: ConnectorKind;

  /** The durable sync-state store. Defaults to the shared in-memory store; prod overrides it. */
  protected store: SyncStateStore = defaultStore;

  private _transformer?: Transformer;

  /**
   * Bind the durable, RLS-scoped sync-state store (the Postgres-backed implementation in production).
   * Called once at bootstrap so `pushTransaction`'s idempotency + attempt accounting survive restarts,
   * worker-replica fan-out, and Kafka rebalances — the gap the in-memory `Map` left open.
   */
  useSyncStateStore(store: SyncStateStore): void {
    this.store = store;
  }

  /**
   * Maps the domain entity → this ERP's specific push payload before the push (the strategy half of
   * the adapter/strategy/factory decomposition, mirroring the donor's `*_bill_transformer`). Defaults
   * to a pass-through; a connector overrides this getter with `get transformer()` returning its own
   * {@link Transformer} (the default is lazy because it depends on the subclass's `kind`).
   */
  protected get transformer(): Transformer {
    return (this._transformer ??= new IdentityTransformer(this.kind));
  }

  /**
   * Push the ERP-shaped payload. The base has already applied {@link transformer} to `req`, so
   * subclasses build their response from `payload`; `req` is still provided for entity/idempotency
   * metadata. The transformed payload is also returned to consumers via {@link PushResult.payload}.
   */
  protected abstract doPush(
    config: ConnectorConfig,
    req: PushRequest,
    payload: ErpPayload,
  ): Promise<PushResult>;
  protected abstract doStatus(config: ConnectorConfig, externalId: string): Promise<ConnectorStatusResult>;

  async authenticate(_config: ConnectorConfig): Promise<void> {
    // Mock connectors accept the configured credentials; real ones perform the handshake here
    // (and refresh-on-401, the donor's CredentialRefreshManager) keyed off config.credentialsRef.
  }

  async healthCheck(_config: ConnectorConfig): Promise<boolean> {
    return true;
  }

  async pushTransaction(config: ConnectorConfig, req: PushRequest): Promise<PushResult> {
    // DURABLE idempotency gate: insert-or-find a sync-state row keyed on idempotencyKey. If a row
    // already exists (another worker/replica/redelivery pushed it), return its recorded outcome WITHOUT
    // re-hitting the ERP — this is the cross-instance guarantee the in-memory Map could not give.
    const { record, existed } = await this.store.upsertQueued({
      tenantId: config.tenantId,
      kind: this.kind,
      entity: req.entity,
      recordId: req.externalRefHint ?? req.idempotencyKey,
      idempotencyKey: req.idempotencyKey,
      externalId: undefined,
    });
    if (existed) {
      Logger.info('connector.push.idempotent-hit', {
        kind: this.kind,
        idempotencyKey: req.idempotencyKey,
        status: record.status,
      });
      return this.resultFromRecord(record);
    }

    // Apply the connector's transformer (domain entity -> ERP payload) before the (mock) push.
    const payload = this.transformer.transform(req, config);

    let result: PushResult;
    let attempts = 0;
    try {
      const ran = await withRetry(async () => {
        await this.authenticate(config);
        return this.doPush(config, req, payload);
      }, this.retriesOf());
      result = ran.value;
      attempts = ran.attempts;
    } catch (err) {
      // Retries exhausted (or an UnrecoverableError short-circuited): park the row as `error` so a
      // dead-lettered envelope is queryable/re-drivable by an operator, then rethrow so the bus's
      // bounded retry → DLQ still engages on the event.
      const message = err instanceof Error ? err.message : String(err);
      await this.store.recordOutcome(
        { tenantId: config.tenantId, idempotencyKey: req.idempotencyKey },
        { status: ConnectorSyncStatus.Error, attemptDelta: this.retriesOf() + 1, lastError: message },
      );
      Logger.error(err as Error, 'CONNECTOR_PUSH', req.entity, { kind: this.kind, idempotencyKey: req.idempotencyKey });
      throw err;
    }

    // Persist the terminal/pending outcome (status, external id, attempt count). A connector that
    // returns `accepted: false` (validation reject) is a permanent error — record it as such.
    const status = result.accepted ? toSyncStatus(result.status) : ConnectorSyncStatus.Error;
    await this.store.recordOutcome(
      { tenantId: config.tenantId, idempotencyKey: req.idempotencyKey },
      {
        status,
        externalId: result.externalId,
        attemptDelta: attempts,
        lastError: result.accepted ? undefined : result.message,
      },
    );

    Logger.info('connector.push', {
      kind: this.kind,
      entity: req.entity,
      idempotencyKey: req.idempotencyKey,
      status: result.status,
      externalId: result.externalId,
      attempts,
    });
    return result;
  }

  async getStatus(config: ConnectorConfig, externalId: string): Promise<ConnectorStatusResult> {
    const { value } = await withRetry(() => this.doStatus(config, externalId));
    return value;
  }

  /**
   * STATUS CALLBACK / RECONCILE: advance one non-terminal sync-state row toward terminal by polling the
   * ERP for its current status, then persisting the result (the donor's status-poll cron, §4 item 3). A
   * scheduled reconcile or the connector-sync consumer drives this for `queued`/`in_progress` rows so a
   * push the ERP accepts asynchronously is eventually resolved (otherwise a `queued` row never settles).
   * Returns the reconciled status, or null if the row has no external id yet (nothing to poll).
   */
  async reconcile(config: ConnectorConfig, record: SyncStateRecord): Promise<ConnectorSyncStatus | null> {
    if (!record.externalId) return null;
    const status = await this.getStatus(config, record.externalId);
    const next = toSyncStatus(status.status);
    if (next === record.status) return next; // no change — leave the row (and its attempt count) alone.
    const updated = await this.store.recordOutcome(
      { tenantId: record.tenantId, idempotencyKey: record.idempotencyKey },
      {
        status: next,
        externalId: status.externalId,
        lastError: next === ConnectorSyncStatus.Error ? status.message : undefined,
      },
    );
    Logger.info('connector.reconcile', {
      kind: this.kind,
      idempotencyKey: record.idempotencyKey,
      from: record.status,
      to: updated.status,
      externalId: status.externalId,
    });
    return updated.status;
  }

  /** Reconstruct a PushResult from a recorded sync-state row (for the idempotent-hit return path). */
  private resultFromRecord(record: SyncStateRecord): PushResult {
    return {
      accepted: record.status !== ConnectorSyncStatus.Error,
      externalId: record.externalId,
      status: record.status as unknown as PushResult['status'],
      message: record.lastError,
    };
  }

  /** Retry budget used by withRetry (kept here so the error-path attempt count stays in lock-step). */
  protected retriesOf(): number {
    return 3;
  }

  /** Deterministic external id from the idempotency key (so retries map to the same record). */
  protected externalIdFor(req: PushRequest): string {
    return `${this.kind}-${req.idempotencyKey}`;
  }
}
