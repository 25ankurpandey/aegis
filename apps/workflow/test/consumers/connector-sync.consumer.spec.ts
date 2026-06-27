/**
 * W2-07 — ERP-sync consumer. Reads a `ConnectorPushRequested` event and performs the connector push
 * OFF the request path. Idempotent via BaseConnector's idempotencyKey: a redelivery (at-least-once
 * from the outbox relay / a Kafka rebalance) is a NO-OP that returns the first result rather than
 * double-pushing to the ERP. Uses the REAL @aegis/connectors mock connectors so idempotency is
 * exercised end-to-end; audit + DB are stubbed so the test needs no real database.
 */
import { EventTopic } from '@aegis/events';
import { ConnectorKind, ConnectorEntity } from '@aegis/shared-enums';
import type { EventEnvelope, ConnectorPushRequestedPayload } from '@aegis/events';

// Audit/DB are stubbed: the consumer records the outcome best-effort, but the test asserts push
// behaviour, not the trail. withTenantTransaction just runs the callback with a sentinel tx.
const auditRecord = jest.fn();
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: (...a: unknown[]) => auditRecord(...a) } }));
jest.mock('@aegis/db', () => ({
  withTenantTransaction: (fn: (t: unknown) => Promise<unknown>) => fn({}),
}));

import { RequestContext } from '@aegis/service-core';
import { pushFromEvent } from '../../src/consumers/connector-sync.consumer';

function envelope(idempotencyKey: string): EventEnvelope<ConnectorPushRequestedPayload> {
  return {
    id: `evt-${idempotencyKey}`,
    topic: EventTopic.ConnectorPushRequested,
    tenantId: 't1',
    correlationId: 'corr-1',
    occurredAt: new Date().toISOString(),
    payload: {
      connectorKind: ConnectorKind.LedgerOne,
      entity: ConnectorEntity.Invoice,
      idempotencyKey,
      recordType: 'invoice',
      recordId: 'inv-1',
      data: { totalAmount: 1000, currency: 'USD', name: 'INV-100' },
      ruleId: 'invoice.approve',
    },
  };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

describe('W2-07 connector-sync consumer', () => {
  beforeEach(() => auditRecord.mockClear());

  it('performs the ERP push from the event', async () => {
    const result = await run(() => pushFromEvent(envelope('idem-push-1')));
    expect(result.accepted).toBe(true);
    expect(result.status).toBe('synced');
  });

  it('records the push outcome on the audit trail', async () => {
    await run(() => pushFromEvent(envelope('idem-audit-1')));
    expect(auditRecord).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a redelivery of the same idempotencyKey is a no-op (same result, single push)', async () => {
    const key = 'idem-redeliver-1';
    const first = await run(() => pushFromEvent(envelope(key)));
    const second = await run(() => pushFromEvent(envelope(key)));
    // Same external id → the redelivery returned the cached first push, not a second ERP record.
    expect(second.externalId).toBe(first.externalId);
    expect(second.externalId).toBeDefined();
  });

  it('rejects an envelope whose tenant does not match the propagated context (fail-closed)', async () => {
    const env = envelope('idem-tenant-1');
    env.tenantId = 'other-tenant';
    await expect(run(() => pushFromEvent(env))).rejects.toThrow(/tenant/i);
  });
});
