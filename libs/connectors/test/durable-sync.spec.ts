import { ConnectorEntity, ConnectorKind, ConnectorSyncStatus } from '@aegis/shared-enums';
import { BaseConnector } from '../src/base-connector';
import { InMemorySyncStateStore } from '../src/sync-state';
import { RetryableError, UnrecoverableError } from '../src/errors';
import type { ConnectorConfig, ConnectorStatusResult, PushRequest, PushResult } from '../src/connector';

/**
 * Tests the donor-faithful durability surface added to BaseConnector:
 *   - DURABLE idempotency across instances (the persisted sync-state row, not the per-process Map),
 *   - status-callback RECONCILE transitions (queued/in_progress → terminal), and
 *   - RETRY-then-error-state (exhausted/unrecoverable push parks a `status=error` row + rethrows).
 */

const config: ConnectorConfig = { kind: ConnectorKind.LedgerOne, tenantId: 't1' };
const req = (over: Partial<PushRequest> = {}): PushRequest => ({
  entity: ConnectorEntity.Invoice,
  idempotencyKey: 'idem-A',
  data: { amount: 1000 },
  ...over,
});

/** A configurable connector that counts pushes and lets a test script the doPush/doStatus behaviour. */
class TestConnector extends BaseConnector {
  readonly kind = ConnectorKind.LedgerOne;
  authCalls = 0;
  pushCalls = 0;
  pushImpl: (req: PushRequest) => Promise<PushResult> = async (r) => ({
    accepted: true,
    externalId: this.externalIdFor(r),
    status: 'queued',
  });
  statusImpl: (externalId: string) => Promise<ConnectorStatusResult> = async (externalId) => ({
    externalId,
    status: 'synced',
  });

  protected async doPush(_c: ConnectorConfig, r: PushRequest): Promise<PushResult> {
    this.pushCalls += 1;
    return this.pushImpl(r);
  }
  override async authenticate(_c: ConnectorConfig): Promise<void> {
    this.authCalls += 1;
  }
  protected async doStatus(_c: ConnectorConfig, externalId: string): Promise<ConnectorStatusResult> {
    return this.statusImpl(externalId);
  }
  protected override retriesOf(): number {
    return 2;
  }
}

describe('BaseConnector durable sync-state', () => {
  it('dedupes across SEPARATE connector instances via the shared durable store (not the in-memory Map)', async () => {
    // Two distinct connector objects — emulating two worker replicas / a restart — sharing one store.
    const store = new InMemorySyncStateStore();
    const a = new TestConnector();
    const b = new TestConnector();
    a.useSyncStateStore(store);
    b.useSyncStateStore(store);

    const first = await a.pushTransaction(config, req({ idempotencyKey: 'cross-1' }));
    const second = await b.pushTransaction(config, req({ idempotencyKey: 'cross-1' }));

    expect(a.pushCalls).toBe(1);
    expect(a.authCalls).toBe(1);
    expect(b.pushCalls).toBe(0); // instance B never hit the ERP — it saw the durable row.
    expect(b.authCalls).toBe(0);
    expect(second.externalId).toBe(first.externalId);

    const row = await store.find({ tenantId: 't1', idempotencyKey: 'cross-1' });
    expect(row?.status).toBe(ConnectorSyncStatus.Queued);
    expect(row?.attempts).toBe(1);
  });

  it('reconcile advances a queued row to terminal by polling the ERP status', async () => {
    const store = new InMemorySyncStateStore();
    const c = new TestConnector();
    c.useSyncStateStore(store);

    await c.pushTransaction(config, req({ idempotencyKey: 'rec-1' })); // lands queued
    const before = await store.find({ tenantId: 't1', idempotencyKey: 'rec-1' });
    expect(before?.status).toBe(ConnectorSyncStatus.Queued);

    // ERP now reports it processed.
    c.statusImpl = async (externalId) => ({ externalId, status: 'synced' });
    const reconcilable = await store.listReconcilable();
    expect(reconcilable).toHaveLength(1);
    const result = await c.reconcile(config, reconcilable[0]);

    expect(result).toBe(ConnectorSyncStatus.Synced);
    const after = await store.find({ tenantId: 't1', idempotencyKey: 'rec-1' });
    expect(after?.status).toBe(ConnectorSyncStatus.Synced);
    expect(await store.listReconcilable()).toHaveLength(0); // no longer non-terminal.
  });

  it('reconcile can transition a stuck row to error (ERP rejected after accept)', async () => {
    const store = new InMemorySyncStateStore();
    const c = new TestConnector();
    c.useSyncStateStore(store);
    await c.pushTransaction(config, req({ idempotencyKey: 'rec-err' }));

    c.statusImpl = async (externalId) => ({ externalId, status: 'error', message: 'rejected by ERP' });
    const [row] = await store.listReconcilable();
    const result = await c.reconcile(config, row);

    expect(result).toBe(ConnectorSyncStatus.Error);
    const after = await store.find({ tenantId: 't1', idempotencyKey: 'rec-err' });
    expect(after?.lastError).toBe('rejected by ERP');
  });

  it('retry-then-error-state: a RetryableError exhausts the budget, parks status=error, and rethrows', async () => {
    const store = new InMemorySyncStateStore();
    const c = new TestConnector();
    c.useSyncStateStore(store);
    c.pushImpl = async () => {
      throw new RetryableError('ERP 503');
    };

    await expect(c.pushTransaction(config, req({ idempotencyKey: 'retry-1' }))).rejects.toThrow('ERP 503');

    expect(c.pushCalls).toBe(3); // initial + 2 retries (retriesOf()=2).
    const row = await store.find({ tenantId: 't1', idempotencyKey: 'retry-1' });
    expect(row?.status).toBe(ConnectorSyncStatus.Error);
    expect(row?.lastError).toBe('ERP 503');
    expect(row?.attempts).toBe(3);
  });

  it('an UnrecoverableError short-circuits the retry budget (single ERP call, parked as error)', async () => {
    const store = new InMemorySyncStateStore();
    const c = new TestConnector();
    c.useSyncStateStore(store);
    c.pushImpl = async () => {
      throw new UnrecoverableError('period closed');
    };

    await expect(c.pushTransaction(config, req({ idempotencyKey: 'unrec-1' }))).rejects.toThrow('period closed');

    expect(c.pushCalls).toBe(1); // NO retries burned on a permanent error.
    const row = await store.find({ tenantId: 't1', idempotencyKey: 'unrec-1' });
    expect(row?.status).toBe(ConnectorSyncStatus.Error);
  });

  it('a connector that returns accepted:false is persisted as a terminal error row', async () => {
    const store = new InMemorySyncStateStore();
    const c = new TestConnector();
    c.useSyncStateStore(store);
    c.pushImpl = async () => ({ accepted: false, status: 'error', message: 'amount required' });

    const res = await c.pushTransaction(config, req({ idempotencyKey: 'reject-1' }));
    expect(res.accepted).toBe(false);
    const row = await store.find({ tenantId: 't1', idempotencyKey: 'reject-1' });
    expect(row?.status).toBe(ConnectorSyncStatus.Error);
    expect(row?.lastError).toBe('amount required');
  });

  it('isolates rows by tenant (same idempotencyKey, different tenant → separate push)', async () => {
    const store = new InMemorySyncStateStore();
    const c = new TestConnector();
    c.useSyncStateStore(store);
    await c.pushTransaction({ kind: ConnectorKind.LedgerOne, tenantId: 't1' }, req({ idempotencyKey: 'shared' }));
    await c.pushTransaction({ kind: ConnectorKind.LedgerOne, tenantId: 't2' }, req({ idempotencyKey: 'shared' }));
    expect(c.pushCalls).toBe(2); // not deduped across tenants.
  });
});
