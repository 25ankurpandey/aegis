/**
 * BUG-0005 — STRANDED-RECORD RECOVERY (invoice consumer).
 *
 * The worker-role `ApprovalCompleted` consumer relays the staged completion to the invoice's own
 * idempotent `applyCompletionFromEvent`, so a stranded invoice (vote committed, in-request advance
 * failed) is advanced from the event. These tests assert: (a) a re-delivered ApprovalCompleted for an
 * invoice record drives applyCompletionFromEvent with the right outcome; (b) a double delivery just
 * calls the idempotent method again (the service no-ops a terminal record); (c) records for OTHER
 * record types (expense/payroll) are ignored; (d) a tenant mismatch fails closed.
 */
import { ApprovalRecordType } from '@aegis/shared-enums';

const subscribe = jest.fn();
jest.mock('@aegis/events', () => {
  const actual = jest.requireActual('@aegis/events');
  return { ...actual, getBus: () => ({ subscribe }) };
});

const applyCompletionFromEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/ioc/container', () => {
  const actual = jest.requireActual('../../src/ioc/container');
  // Preserve `provideSingleton` (the repo/service decorators need it) — only stub `container.get`.
  return { ...actual, container: { get: () => ({ applyCompletionFromEvent }) } };
});

import { RequestContext } from '@aegis/service-core';
import { EventTopic, type EventEnvelope, type ApprovalCompletedPayload } from '@aegis/events';
import { registerConsumers } from '../../src/consumers/approval-completed.consumer';

const INVOICE_ID = 'inv-1';

function envelope(over: Partial<ApprovalCompletedPayload> = {}, tenantId = 't1'): EventEnvelope<ApprovalCompletedPayload> {
  return {
    topic: EventTopic.ApprovalCompleted,
    tenantId,
    payload: {
      approvalId: 'appr-1',
      subjectType: ApprovalRecordType.Invoice,
      subjectId: INVOICE_ID,
      outcome: 'approved',
      recordType: ApprovalRecordType.Invoice,
      recordId: INVOICE_ID,
      decidedBy: 'approver-1',
      ...over,
    },
  } as EventEnvelope<ApprovalCompletedPayload>;
}

/** Resolve the handler the consumer subscribed for ApprovalCompleted. */
function handler(): (env: EventEnvelope<ApprovalCompletedPayload>) => Promise<void> {
  registerConsumers();
  const call = subscribe.mock.calls.find((c) => c[0] === EventTopic.ApprovalCompleted);
  return call![1];
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return RequestContext.run({ tenantId, correlationId: 'corr-1', startedAt: Date.now() } as never, fn);
}

beforeEach(() => {
  subscribe.mockClear();
  applyCompletionFromEvent.mockClear();
});

it('advances a stranded invoice from a (re-delivered) ApprovalCompleted', async () => {
  const onCompleted = handler();
  await withTenant('t1', () => onCompleted(envelope({ outcome: 'approved' })));
  expect(applyCompletionFromEvent).toHaveBeenCalledWith(INVOICE_ID, 'approved', 'approver-1');
});

it('double delivery just re-invokes the idempotent applyCompletionFromEvent (service no-ops)', async () => {
  const onCompleted = handler();
  await withTenant('t1', () => onCompleted(envelope()));
  await withTenant('t1', () => onCompleted(envelope()));
  expect(applyCompletionFromEvent).toHaveBeenCalledTimes(2);
  expect(applyCompletionFromEvent).toHaveBeenNthCalledWith(2, INVOICE_ID, 'approved', 'approver-1');
});

it('ignores ApprovalCompleted for a non-invoice record type', async () => {
  const onCompleted = handler();
  await withTenant('t1', () =>
    onCompleted(envelope({ recordType: ApprovalRecordType.PayRun, subjectType: ApprovalRecordType.PayRun })),
  );
  expect(applyCompletionFromEvent).not.toHaveBeenCalled();
});

it('fails closed when the envelope tenant does not match the propagated context tenant', async () => {
  const onCompleted = handler();
  await expect(withTenant('t2', () => onCompleted(envelope({}, 't1')))).rejects.toThrow(/tenant/i);
  expect(applyCompletionFromEvent).not.toHaveBeenCalled();
});
