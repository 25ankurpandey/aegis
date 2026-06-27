/**
 * BUG-0005 — STRANDED-RECORD RECOVERY (payroll consumer).
 *
 * The worker-role `ApprovalCompleted` consumer relays the staged completion to the run's own
 * idempotent `applyCompletionFromEvent`, recovering a run stranded in CALCULATED. Tests: a
 * re-delivered completion advances it; a double delivery re-invokes the idempotent method; other
 * record types are ignored; a tenant mismatch fails closed.
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

const RUN_ID = 'run-1';

function envelope(over: Partial<ApprovalCompletedPayload> = {}, tenantId = 't1'): EventEnvelope<ApprovalCompletedPayload> {
  return {
    topic: EventTopic.ApprovalCompleted,
    tenantId,
    payload: {
      approvalId: 'appr-1',
      subjectType: ApprovalRecordType.PayRun,
      subjectId: RUN_ID,
      outcome: 'approved',
      recordType: ApprovalRecordType.PayRun,
      recordId: RUN_ID,
      decidedBy: 'checker-1',
      ...over,
    },
  } as EventEnvelope<ApprovalCompletedPayload>;
}

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

it('advances a stranded pay run from a (re-delivered) ApprovalCompleted', async () => {
  const onCompleted = handler();
  await withTenant('t1', () => onCompleted(envelope({ outcome: 'approved' })));
  expect(applyCompletionFromEvent).toHaveBeenCalledWith(RUN_ID, 'approved', 'checker-1');
});

it('double delivery just re-invokes the idempotent applyCompletionFromEvent (service no-ops)', async () => {
  const onCompleted = handler();
  await withTenant('t1', () => onCompleted(envelope()));
  await withTenant('t1', () => onCompleted(envelope()));
  expect(applyCompletionFromEvent).toHaveBeenCalledTimes(2);
});

it('ignores ApprovalCompleted for a non-payroll record type', async () => {
  const onCompleted = handler();
  await withTenant('t1', () =>
    onCompleted(envelope({ recordType: ApprovalRecordType.Invoice, subjectType: ApprovalRecordType.Invoice })),
  );
  expect(applyCompletionFromEvent).not.toHaveBeenCalled();
});

it('fails closed when the envelope tenant does not match the propagated context tenant', async () => {
  const onCompleted = handler();
  await expect(withTenant('t2', () => onCompleted(envelope({}, 't1')))).rejects.toThrow(/tenant/i);
  expect(applyCompletionFromEvent).not.toHaveBeenCalled();
});
