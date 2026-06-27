/**
 * BUG-0005 — STRANDED-RECORD RECOVERY (expense consumer).
 *
 * The worker-role `ApprovalCompleted` consumer relays the staged completion to the report's own
 * idempotent `applyCompletionFromEvent`, recovering a report stranded in APPROVALS. Tests: a
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

const REPORT_ID = 'rep-1';

function envelope(over: Partial<ApprovalCompletedPayload> = {}, tenantId = 't1'): EventEnvelope<ApprovalCompletedPayload> {
  return {
    topic: EventTopic.ApprovalCompleted,
    tenantId,
    payload: {
      approvalId: 'appr-1',
      subjectType: ApprovalRecordType.ExpenseReport,
      subjectId: REPORT_ID,
      outcome: 'approved',
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: REPORT_ID,
      decidedBy: 'approver-1',
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

it('advances a stranded report from a (re-delivered) ApprovalCompleted', async () => {
  const onCompleted = handler();
  await withTenant('t1', () => onCompleted(envelope({ outcome: 'approved' })));
  expect(applyCompletionFromEvent).toHaveBeenCalledWith(REPORT_ID, 'approved', 'approver-1');
});

it('double delivery just re-invokes the idempotent applyCompletionFromEvent (service no-ops)', async () => {
  const onCompleted = handler();
  await withTenant('t1', () => onCompleted(envelope()));
  await withTenant('t1', () => onCompleted(envelope()));
  expect(applyCompletionFromEvent).toHaveBeenCalledTimes(2);
});

it('ignores ApprovalCompleted for a non-expense record type', async () => {
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
