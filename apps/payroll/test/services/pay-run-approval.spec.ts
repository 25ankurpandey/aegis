/**
 * Pay-run approval is delegated to the shared multi-level approval engine (`@aegis/approvals`),
 * replacing the old single-shot inline approve. These tests prove:
 *   - `decide` lazily materialises the chain (requestedBy = the CREATOR) and, while the chain is open,
 *     leaves the run CALCULATED (no premature Approved transition, no PayRunApproved event);
 *   - on a COMPLETED-approved chain the run advances to Approved with a locked snapshot + the
 *     PayRunApproved event staged in the same tx;
 *   - on a COMPLETED-rejected chain the run stays CALCULATED (revisable) and emits no approval event;
 *   - an EMPTY chain (engine auto-completed) advances straight to Approved;
 *   - SEGREGATION OF DUTIES: the run's creator can NEVER approve their own run (hard in-service guard),
 *     even when the policy/engine would otherwise let them.
 */
import { EventTopic } from '@aegis/events';
import { PayRunStatus, ApprovalRecordType, ApprovalDecision } from '@aegis/shared-enums';

const stageOutboxEvent = jest.fn();
jest.mock('@aegis/events', () => {
  const actual = jest.requireActual('@aegis/events');
  return {
    ...actual,
    stageOutboxEvent: (...args: unknown[]) => stageOutboxEvent(...args),
    makeEnvelope: (topic: unknown, payload: unknown) => ({ topic, payload, tenantId: 't1' }),
  };
});

const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
jest.mock('@aegis/db', () => ({ withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])) }));

jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn() } }));
const activityRecord = jest.fn();
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: (...a: unknown[]) => activityRecord(...a) } }));

import { RequestContext } from '@aegis/service-core';
import { PayRunService } from '../../src/services/pay-run.service';

const RUN_ID = 'run-1';
const CREATOR = 'maker-1';
const CHECKER = 'checker-1';

function calculatedRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    tenant_id: 't1',
    pay_calendar_id: null,
    period_start: '2026-01-01',
    period_end: '2026-01-15',
    pay_date: '2026-01-20',
    type: 'regular',
    status: PayRunStatus.Calculated,
    created_by: CREATOR,
    approved_by: null,
    approved_at: null,
    locked_snapshot: null,
    ...overrides,
  };
}

/**
 * A repo whose `findPayRunById` returns the supplied run, advancing to Approved after the
 * version-checked `updatePayRunVersioned` (W5-07). `updatePayRun` is kept for any non-transition use.
 */
function makeRepo(run: Record<string, unknown>) {
  let current = run;
  const apply = async (_id: string, patch: Record<string, unknown>) => {
    current = { ...current, ...patch };
    return current;
  };
  return {
    findPayRunById: jest.fn(async () => current),
    listPayslipsByRun: jest.fn().mockResolvedValue([
      { id: 'slip-1', employee_id: 'e1', gross: 1000, taxable_base: 1000, total_tax: 0, total_deductions: 0, currency: 'USD' },
    ]),
    updatePayRun: jest.fn(apply),
    updatePayRunVersioned: jest.fn(
      async (id: string, _expectedVersion: number, patch: Record<string, unknown>) => apply(id, patch),
    ),
  };
}

/** A mock ApprovalService whose requestApproval/decide are scripted per test. */
function makeApprovals(opts: {
  chain?: unknown[];
  completed?: boolean;
  outcome?: 'approved' | 'rejected';
}) {
  const chain = opts.chain ?? [{ id: 's1', level: 1, approver_id: CHECKER, status: 'pending' }];
  return {
    requestApproval: jest.fn().mockResolvedValue({ recordType: ApprovalRecordType.PayRun, recordId: RUN_ID, chain }),
    decide: jest.fn().mockResolvedValue({
      recordType: ApprovalRecordType.PayRun,
      recordId: RUN_ID,
      completed: opts.completed ?? false,
      outcome: opts.outcome,
      chain,
    }),
    // BUG-0005 self-heal pre-check: by default the chain is NOT already terminal, so the normal
    // vote path runs. Tests that exercise the stranded-recovery path script this per case.
    getStatus: jest.fn().mockResolvedValue({ recordType: ApprovalRecordType.PayRun, recordId: RUN_ID, completed: false, chain }),
    listPendingForApprover: jest.fn().mockResolvedValue([]),
  };
}

function asChecker<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: CHECKER, correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}
function asCreator<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: CREATOR, correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

function approvedEvents() {
  return stageOutboxEvent.mock.calls.map((c) => c[0]).filter((e) => e.topic === EventTopic.PayRunApproved);
}

describe('pay-run.decide — shared-engine approval (maker-checker)', () => {
  beforeEach(() => {
    stageOutboxEvent.mockClear();
    activityRecord.mockClear();
  });

  it('materialises the chain keyed (pay_run, runId) with requestedBy = the CREATOR', async () => {
    const repo = makeRepo(calculatedRun());
    const approvals = makeApprovals({ completed: false });
    const service = new PayRunService(repo as never, {} as never, approvals as never);

    await asChecker(() => service.decide(RUN_ID, { decision: 'approved' }));

    expect(approvals.requestApproval).toHaveBeenCalledWith({
      recordType: ApprovalRecordType.PayRun,
      recordId: RUN_ID,
      requestedBy: CREATOR,
    });
  });

  it('leaves the run CALCULATED and emits NO PayRunApproved while the chain is still open', async () => {
    const repo = makeRepo(calculatedRun());
    const approvals = makeApprovals({ completed: false });
    const service = new PayRunService(repo as never, {} as never, approvals as never);

    const dto = await asChecker(() => service.decide(RUN_ID, { decision: 'approved' }));

    expect(dto.status).toBe(PayRunStatus.Calculated);
    expect(repo.updatePayRun).not.toHaveBeenCalled();
    expect(approvedEvents()).toHaveLength(0);
  });

  it('advances to Approved + stages PayRunApproved when the chain completes approved', async () => {
    const repo = makeRepo(calculatedRun());
    const approvals = makeApprovals({ completed: true, outcome: 'approved' });
    const service = new PayRunService(repo as never, {} as never, approvals as never);

    const dto = await asChecker(() => service.decide(RUN_ID, { decision: 'approved' }));

    expect(approvals.decide).toHaveBeenCalledWith(
      expect.objectContaining({
        recordType: ApprovalRecordType.PayRun,
        recordId: RUN_ID,
        approverId: CHECKER,
        decision: ApprovalDecision.Approved,
      }),
    );
    expect(dto.status).toBe(PayRunStatus.Approved);
    expect(dto.approvedBy).toBe(CHECKER);
    // The approval write locks a snapshot AND is version-checked (W5-07): id, expectedVersion, patch, tx.
    expect(repo.updatePayRunVersioned).toHaveBeenCalledWith(
      RUN_ID,
      expect.any(Number),
      expect.objectContaining({ status: PayRunStatus.Approved, approved_by: CHECKER, locked_snapshot: expect.any(Object) }),
      expect.anything(),
    );
    const ev = approvedEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ payRunId: RUN_ID, approvedBy: CHECKER, recipientUserId: CREATOR });
  });

  it('keeps the run CALCULATED and emits NO event when the chain completes rejected', async () => {
    const repo = makeRepo(calculatedRun());
    const approvals = makeApprovals({ completed: true, outcome: 'rejected' });
    const service = new PayRunService(repo as never, {} as never, approvals as never);

    const dto = await asChecker(() => service.decide(RUN_ID, { decision: 'rejected' }));

    expect(approvals.decide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: ApprovalDecision.Rejected }),
    );
    expect(dto.status).toBe(PayRunStatus.Calculated);
    expect(repo.updatePayRun).not.toHaveBeenCalled();
    expect(approvedEvents()).toHaveLength(0);
  });

  it('advances straight to Approved when the engine returns an EMPTY chain (auto-completed)', async () => {
    const repo = makeRepo(calculatedRun());
    const approvals = makeApprovals({ chain: [], completed: false });
    const service = new PayRunService(repo as never, {} as never, approvals as never);

    const dto = await asChecker(() => service.decide(RUN_ID, { decision: 'approved' }));

    // No vote is recorded for an auto-completed chain — we never reach the engine's decide().
    expect(approvals.decide).not.toHaveBeenCalled();
    expect(dto.status).toBe(PayRunStatus.Approved);
    expect(approvedEvents()).toHaveLength(1);
  });

  it('SoD: the run CREATOR can never approve their own run (hard guard, before the engine)', async () => {
    const repo = makeRepo(calculatedRun());
    const approvals = makeApprovals({ completed: true, outcome: 'approved' });
    const service = new PayRunService(repo as never, {} as never, approvals as never);

    await expect(asCreator(() => service.decide(RUN_ID, { decision: 'approved' }))).rejects.toThrow(
      /[Ss]egregation of duties/,
    );
    // The guard fires BEFORE any engine interaction or status write.
    expect(approvals.requestApproval).not.toHaveBeenCalled();
    expect(approvals.decide).not.toHaveBeenCalled();
    expect(repo.updatePayRun).not.toHaveBeenCalled();
  });

  it('rejects a decision on a run that is not CALCULATED (e.g. already Approved)', async () => {
    const repo = makeRepo(calculatedRun({ status: PayRunStatus.Approved }));
    const approvals = makeApprovals({ completed: true, outcome: 'approved' });
    const service = new PayRunService(repo as never, {} as never, approvals as never);

    await expect(asChecker(() => service.decide(RUN_ID, { decision: 'approved' }))).rejects.toThrow();
    expect(approvals.requestApproval).not.toHaveBeenCalled();
  });

  it('approve() is a thin alias for decide({ decision: approved })', async () => {
    const repo = makeRepo(calculatedRun());
    const approvals = makeApprovals({ completed: true, outcome: 'approved' });
    const service = new PayRunService(repo as never, {} as never, approvals as never);

    const dto = await asChecker(() => service.approve(RUN_ID));

    expect(dto.status).toBe(PayRunStatus.Approved);
    expect(approvals.decide).toHaveBeenCalledWith(
      expect.objectContaining({ decision: ApprovalDecision.Approved }),
    );
  });
});

describe('pay-run.listPendingApprovals — the approver inbox', () => {
  it('hydrates each pending slot with its run header (RLS-scoped)', async () => {
    const repo = makeRepo(calculatedRun());
    const approvals = makeApprovals({});
    approvals.listPendingForApprover = jest
      .fn()
      .mockResolvedValue([{ record_id: RUN_ID, level: 1 }]);
    const service = new PayRunService(repo as never, {} as never, approvals as never);

    const inbox = await asChecker(() => service.listPendingApprovals());

    expect(approvals.listPendingForApprover).toHaveBeenCalledWith(CHECKER, ApprovalRecordType.PayRun);
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ payRunId: RUN_ID, level: 1 });
    expect(inbox[0].payRun.id).toBe(RUN_ID);
  });
});
