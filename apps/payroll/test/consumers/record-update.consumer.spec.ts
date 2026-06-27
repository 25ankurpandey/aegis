/**
 * BUG-0003 — RecordUpdated consumer (payroll half). The workflow `assign_team` / `add_tag` actions
 * PRODUCE `EventTopic.RecordUpdated` but, before this consumer, NOTHING subscribed — so the action
 * reported success while the write silently never happened. This worker-role consumer relays the
 * annotation to the pay run's idempotent `applyRecordUpdate`. Tests: a pay_run RecordUpdated
 * applies team/tags; a non-expense type is ignored; an empty annotation is a clean skip; a tenant
 * mismatch fails closed.
 */
import { ApprovalRecordType } from '@aegis/shared-enums';

const subscribe = jest.fn();
jest.mock('@aegis/events', () => {
  const actual = jest.requireActual('@aegis/events');
  return { ...actual, getBus: () => ({ subscribe }) };
});

const applyRecordUpdate = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/ioc/container', () => {
  const actual = jest.requireActual('../../src/ioc/container');
  return { ...actual, container: { get: () => ({ applyRecordUpdate }) } };
});

import { RequestContext } from '@aegis/service-core';
import { EventTopic, type EventEnvelope, type RecordUpdatedPayload } from '@aegis/events';
import { registerRecordUpdateConsumer } from '../../src/consumers/record-update.consumer';

const RUN_ID = 'run-1';

function envelope(
  over: Partial<RecordUpdatedPayload> = {},
  tenantId = 't1',
): EventEnvelope<RecordUpdatedPayload> {
  return {
    id: 'evt-1',
    topic: EventTopic.RecordUpdated,
    tenantId,
    correlationId: 'corr-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    payload: {
      recordType: ApprovalRecordType.PayRun,
      recordId: RUN_ID,
      teamId: 'team-9',
      tags: ['urgent', 'q3'],
      ruleId: 'rule-tag',
      ...over,
    },
  };
}

function handler(): (env: EventEnvelope<RecordUpdatedPayload>) => Promise<void> {
  registerRecordUpdateConsumer();
  const call = subscribe.mock.calls.find((c) => c[0] === EventTopic.RecordUpdated);
  return call![1];
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId, correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

beforeEach(() => {
  subscribe.mockClear();
  applyRecordUpdate.mockClear();
});

it('subscribes to RecordUpdated', () => {
  handler();
  expect(subscribe).toHaveBeenCalledWith(EventTopic.RecordUpdated, expect.any(Function));
});

it('applies team + tags for a pay_run RecordUpdated', async () => {
  const onRecordUpdated = handler();
  await withTenant('t1', () => onRecordUpdated(envelope()));
  expect(applyRecordUpdate).toHaveBeenCalledWith(RUN_ID, {
    teamId: 'team-9',
    tags: ['urgent', 'q3'],
    ruleId: 'rule-tag',
  });
});

it('applies a null assignee to clear record ownership', async () => {
  const onRecordUpdated = handler();
  await withTenant('t1', () =>
    onRecordUpdated(envelope({ teamId: undefined, tags: undefined, assigneeId: null })),
  );
  expect(applyRecordUpdate).toHaveBeenCalledWith(RUN_ID, {
    assigneeId: null,
    ruleId: 'rule-tag',
  });
});

it('ignores RecordUpdated for a non-pay-run record type', async () => {
  const onRecordUpdated = handler();
  await withTenant('t1', () =>
    onRecordUpdated(envelope({ recordType: ApprovalRecordType.Invoice })),
  );
  expect(applyRecordUpdate).not.toHaveBeenCalled();
});

it('skips cleanly when neither a team nor tags are present (nothing to apply)', async () => {
  const onRecordUpdated = handler();
  await withTenant('t1', () =>
    onRecordUpdated(envelope({ teamId: undefined, tags: undefined, ruleId: 'rule-x' })),
  );
  expect(applyRecordUpdate).not.toHaveBeenCalled();
});

it('applies a team-only annotation (assign_team with no tags)', async () => {
  const onRecordUpdated = handler();
  await withTenant('t1', () => onRecordUpdated(envelope({ teamId: 'team-2', tags: undefined })));
  expect(applyRecordUpdate).toHaveBeenCalledWith(RUN_ID, {
    teamId: 'team-2',
    tags: undefined,
    ruleId: 'rule-tag',
  });
});

it('fails closed when the envelope tenant does not match the propagated context tenant', async () => {
  const onRecordUpdated = handler();
  await expect(withTenant('t2', () => onRecordUpdated(envelope({}, 't1')))).rejects.toThrow(
    /tenant/i,
  );
  expect(applyRecordUpdate).not.toHaveBeenCalled();
});
