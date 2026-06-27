import { RequestContext } from '@aegis/service-core';
import { ApprovalDecision } from '@aegis/shared-enums';
import { EventTopic, type EventEnvelope, type ApprovalCommandPayload } from '@aegis/events';

/**
 * BUG-0001 regression. A workflow `auto_approve` / `assign_approval_policy` rule action publishes
 * `ApprovalCommand`, but before the fix NOTHING subscribed, so the action reported success while the
 * command silently no-op'd. The consumer applies the command via the shared ApprovalService using
 * ONLY its existing methods (requestApproval / getStatus / decide).
 *
 * The container + ApprovalService are faked: a tiny in-memory chain models requestApproval / getStatus
 * / decide so we can assert the consumer drives the chain to APPROVED (auto_approve) and materialises
 * the chain (assign_approval_policy) — under the propagated tenant context — without a real DB/engine.
 */

// ---- in-memory ApprovalService fake -----------------------------------------------------------

interface Slot {
  approver_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'skipped' | 'superseded';
  level: number;
}

const calls = {
  requestApproval: jest.fn(),
  decide: jest.fn(),
};

/** A 2-level sequential chain (one approver each). decide() advances the active level. */
function makeFakeApprovals(initialChain: Slot[]) {
  let chain: Slot[] = initialChain.map((s) => ({ ...s }));
  let materialised = chain.length > 0;

  const completed = () => chain.length > 0 && chain.every((s) => s.status !== 'pending');

  return {
    chain: () => chain,
    requestApproval: jest.fn(async (input: { recordType: string; recordId: string; requestedBy: string }) => {
      calls.requestApproval(input);
      materialised = true;
      return { recordType: input.recordType, recordId: input.recordId, mode: 'sequential', minApprovals: 1, chain };
    }),
    getStatus: jest.fn(async (recordType: string, recordId: string) => ({
      recordType,
      recordId,
      mode: 'sequential',
      minApprovals: 1,
      completed: materialised && completed(),
      chain,
      history: chain,
      votes: [],
    })),
    decide: jest.fn(async (input: { recordType: string; recordId: string; approverId: string; decision: string; comment?: string }) => {
      calls.decide(input);
      const slot = chain.find((s) => s.approver_id === input.approverId && s.status === 'pending');
      if (!slot) throw new Error('not a pending approver');
      slot.status = input.decision === ApprovalDecision.Approved ? 'approved' : 'rejected';
      return { recordType: input.recordType, recordId: input.recordId, completed: completed(), outcome: completed() ? 'approved' : undefined, chain };
    }),
  };
}

let fakeApprovals: ReturnType<typeof makeFakeApprovals>;

jest.mock('../../src/ioc/container', () => ({
  container: { get: () => fakeApprovals },
  provideSingleton: () => () => undefined,
}));

import { applyApprovalCommand } from '../../src/consumers/approval-command.consumer';

const TENANT = 'tenant-cmd-1';

function envelope(payload: Partial<ApprovalCommandPayload>): EventEnvelope<ApprovalCommandPayload> {
  return {
    id: 'evt-1',
    topic: EventTopic.ApprovalCommand,
    tenantId: TENANT,
    correlationId: 'corr-1',
    occurredAt: new Date().toISOString(),
    payload: {
      recordType: 'expense_report',
      recordId: 'rep-1',
      ruleId: 'rule-auto',
      ...payload,
    },
  };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run({ tenantId: TENANT, correlationId: 'corr-1', startedAt: Date.now() } as never, fn);
}

describe('BUG-0001 — ApprovalCommand consumer applies rule-driven commands', () => {
  beforeEach(() => {
    calls.requestApproval.mockClear();
    calls.decide.mockClear();
  });

  it('auto_approve drives every pending level to APPROVED via decide()', async () => {
    fakeApprovals = makeFakeApprovals([
      { approver_id: 'mgr-1', status: 'pending', level: 1 },
      { approver_id: 'dir-1', status: 'pending', level: 2 },
    ]);

    await run(() => applyApprovalCommand(envelope({ autoApprove: true, reason: 'fast-track' })));

    // Both approver slots were decided, and the chain ended completed/approved.
    expect(calls.decide).toHaveBeenCalledTimes(2);
    expect(calls.decide.mock.calls.map((c) => c[0].approverId)).toEqual(['mgr-1', 'dir-1']);
    expect(calls.decide.mock.calls[0][0]).toMatchObject({ decision: ApprovalDecision.Approved, comment: 'fast-track' });
    expect(fakeApprovals.chain().every((s) => s.status === 'approved')).toBe(true);
  });

  it('auto_approve on an empty (auto-completing) chain decides nothing', async () => {
    fakeApprovals = makeFakeApprovals([]); // requestApproval returns an empty chain (engine auto-completed)
    await run(() => applyApprovalCommand(envelope({ autoApprove: true })));
    expect(calls.requestApproval).toHaveBeenCalledTimes(1);
    expect(calls.decide).not.toHaveBeenCalled();
  });

  it('assign_approval_policy materialises the chain without auto-deciding', async () => {
    fakeApprovals = makeFakeApprovals([{ approver_id: 'mgr-1', status: 'pending', level: 1 }]);
    await run(() => applyApprovalCommand(envelope({ policyId: 'policy-strict' })));
    expect(calls.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: 'expense_report', recordId: 'rep-1' }),
    );
    expect(calls.decide).not.toHaveBeenCalled();
  });

  it('rejects an envelope whose tenant does not match the rebuilt context (fail-closed)', async () => {
    fakeApprovals = makeFakeApprovals([{ approver_id: 'mgr-1', status: 'pending', level: 1 }]);
    const mismatched = { ...envelope({ autoApprove: true }), tenantId: 'someone-else' };
    await expect(run(() => applyApprovalCommand(mismatched))).rejects.toThrow(/tenant/);
    expect(calls.decide).not.toHaveBeenCalled();
  });
});
