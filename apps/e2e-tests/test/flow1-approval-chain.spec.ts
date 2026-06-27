/**
 * FLOW 1 — APPROVAL CHAIN (expense submit → shared approval engine → record advances).
 *
 * The closest thing to an E2E of the approval story without Postgres/Docker: it wires the REAL shared
 * approval engine (`@aegis/approvals` `ApprovalService` + its real repositories + the real
 * `PolicyApproverResolver`) underneath a thin Expense owner that plays exactly the role
 * `apps/expense/src/services/expense.service.ts` plays — submit a report, ask the engine to
 * materialise the approver chain from the seeded per-tenant policy, then advance the report's status
 * when the engine reports the chain COMPLETED (the in-process `ApprovalCompleted` handler).
 *
 * What is REAL here: the policy resolution (W3-02), amount-threshold level inclusion (W3-03), SoD
 * exclude-requester (the requester can't approve their own record), multilevel sequential advance,
 * per-level vote recording + no-double-vote, reject short-circuit, and the single `ApprovalCompleted`
 * emission. Only the DB seam (`withTenantTransaction`), the model context, the outbox event seam, and
 * `RequestContext` are mocked — the engine, repositories, and resolver run for real on top.
 *
 * Asserted end-to-end: multilevel chain + SoD (requester excluded) + amount-threshold level inclusion,
 * and that the expense report status advances submitted → APPROVALS → APPROVED as the chain resolves.
 */
import type { Transaction } from 'sequelize';
import {
  ApprovalMode,
  ApproverType,
  ApproverSource,
  ApprovalDecision,
  ApprovalRecordType,
  RecordApproverStatus,
  ExpenseReportStatus,
} from '@aegis/shared-enums';
import type { ApprovalShape } from '@aegis/shared-types';
import { makeModel, type InMemoryModel } from '../src/harness/in-memory-model';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TX = 'TX' as unknown as Transaction;

let activeTenant = TENANT_A;

// ---- the approval engine's six tables, in-memory + tenant-partitioned ("RLS") ----------------

interface ApprovalCtx {
  Policy: InMemoryModel;
  Hierarchy: InMemoryModel;
  Group: InMemoryModel;
  GroupMember: InMemoryModel;
  RecordApprover: InMemoryModel;
  Vote: InMemoryModel;
}
let ctx: ApprovalCtx;

/** Topics the engine staged to the outbox during a run — the cross-service notification/completion seam. */
const stagedEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];

function freshContext(): void {
  const t = () => activeTenant;
  ctx = {
    Policy: makeModel(t),
    Hierarchy: makeModel(t),
    Group: makeModel(t),
    GroupMember: makeModel(t),
    RecordApprover: makeModel(t),
    Vote: makeModel(t),
  };
}

// ---- module mocks (the only seams faked; the engine + repos + resolver run for real) ----------

jest.mock('@aegis/db', () => ({
  withTenantTransaction: jest.fn(async (fn: (t: Transaction) => Promise<unknown>) => fn(TX)),
}));

jest.mock('@aegis/service-core', () => {
  const ErrorType = { Forbidden: 'forbidden', NotFound: 'not_found', Conflict: 'conflict' } as const;
  class AppError extends Error {
    constructor(public type: string, message: string) {
      super(message);
    }
  }
  return {
    RequestContext: { tenantId: () => activeTenant, userId: () => undefined },
    ErrUtils: {
      forbidden: (m = 'Forbidden') => new AppError(ErrorType.Forbidden, m),
      notFound: (m: string) => new AppError(ErrorType.NotFound, m),
      conflict: (m: string) => new AppError(ErrorType.Conflict, m),
    },
    AppError,
  };
});

jest.mock('@aegis/events', () => ({
  EventTopic: {
    ApprovalRequested: 'approval.requested',
    ApprovalCompleted: 'approval.completed',
  },
  makeEnvelope: (topic: string, payload: Record<string, unknown>) => ({ topic, payload, tenantId: activeTenant }),
  stageOutboxEvent: jest.fn(async (env: { topic: string; payload: Record<string, unknown> }) => {
    stagedEvents.push({ topic: env.topic, payload: env.payload });
  }),
}));

// The repositories import the approval model context by relative path inside the lib; intercepting
// that path swaps the real Sequelize-backed context for the in-memory, tenant-partitioned one.
jest.mock('../../../libs/approvals/src/models/database-context', () => ({
  getApprovalContext: () => ctx,
  resetApprovalContext: () => undefined,
}));

// Imported AFTER the mocks so the engine + repos bind to the mocked seams.
import { ApprovalService } from '@aegis/approvals';
import { PolicyRepository } from '../../../libs/approvals/src/repositories/policy.repository';
import { RecordApproverRepository } from '../../../libs/approvals/src/repositories/record-approver.repository';
import { VoteRepository } from '../../../libs/approvals/src/repositories/vote.repository';

function buildEngine(): ApprovalService {
  return new ApprovalService(
    new PolicyRepository(),
    new RecordApproverRepository(),
    new VoteRepository(),
  );
}

// ---- a thin Expense owner that mirrors expense.service.ts's engine-backed lifecycle -----------

/**
 * The harness stand-in for `ExpenseService`: it owns the report row + status, drives the REAL shared
 * approval engine exactly as the production service does (submit → requestApproval keyed by
 * (ExpenseReport, reportId) with the report total + currency; decide → advance on ApprovalCompleted),
 * and is the in-process `ApprovalCompleted` handler that flips the report to APPROVED/REJECTED. This
 * is the same wiring contract the real service implements; only its persistence is the in-memory map.
 */
class ExpenseOwner {
  private status = ExpenseReportStatus.Open;
  constructor(
    private readonly engine: ApprovalService,
    readonly reportId: string,
    private readonly amountMinor: number,
    private readonly currency: string,
    private readonly submitterId: string,
  ) {}

  getStatus(): ExpenseReportStatus {
    return this.status;
  }

  async submit(): Promise<ApprovalShape.RequestApprovalResult> {
    this.status = ExpenseReportStatus.Approvals;
    const result = await this.engine.requestApproval({
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: this.reportId,
      amountMinor: this.amountMinor,
      currency: this.currency,
      requestedBy: this.submitterId,
    });
    // Empty chain ⇒ the engine auto-completed (no required approvers): advance straight to APPROVED.
    if (result.chain.length === 0) this.applyCompletion('approved');
    return result;
  }

  async decide(approverId: string, decision: ApprovalDecision): Promise<ApprovalShape.DecisionResult> {
    const result = await this.engine.decide({
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: this.reportId,
      approverId,
      decision,
    });
    // In-process ApprovalCompleted handling (no worker): on a terminal chain, advance the report.
    if (result.completed && result.outcome) this.applyCompletion(result.outcome);
    return result;
  }

  /** The ApprovalCompleted handler: approved → APPROVED, rejected → REJECTED (idempotent). */
  private applyCompletion(outcome: ApprovalShape.ChainOutcome): void {
    this.status = outcome === 'approved' ? ExpenseReportStatus.Approved : ExpenseReportStatus.Rejected;
  }
}

// ---- fixtures ---------------------------------------------------------------------------------

const REPORT = 'report-001';
const ALICE = 'user-alice'; // L1 manager
const BOB = 'user-bob'; // L2 finance / senior
const CAROL = 'user-carol'; // submitter
const USD = 'USD';

async function seedPolicy(p: Partial<ApprovalShape.PolicyRow>): Promise<void> {
  await ctx.Policy.create({
    tenant_id: activeTenant,
    record_type: ApprovalRecordType.ExpenseReport,
    name: 'std',
    mode: ApprovalMode.Sequential,
    min_approvals: 1,
    is_active: true,
    config: {},
    ...p,
  });
}

beforeEach(() => {
  activeTenant = TENANT_A;
  stagedEvents.length = 0;
  freshContext();
});

// ---- the flow ---------------------------------------------------------------------------------

describe('FLOW 1 — expense submit drives the shared approval engine and advances on completion', () => {
  it('multilevel sequential chain: submit → requestApproval → decide L1 → decide L2 → APPROVED', async () => {
    // A two-level sequential policy: L1 = manager Alice, L2 = finance Bob.
    await seedPolicy({
      mode: ApprovalMode.Sequential,
      min_approvals: 2,
      config: {
        levels: [
          { level: 1, source: ApproverSource.User, approver_type: ApproverType.User, approver_id: ALICE },
          { level: 2, source: ApproverSource.User, approver_type: ApproverType.User, approver_id: BOB },
        ],
      },
    });
    const owner = new ExpenseOwner(buildEngine(), REPORT, 50_00, USD, CAROL);

    // SUBMIT: the engine resolves the policy + materialises the 2-level chain; report → APPROVALS.
    const chain = await owner.submit();
    expect(owner.getStatus()).toBe(ExpenseReportStatus.Approvals);
    expect(chain.mode).toBe(ApprovalMode.Sequential);
    expect(chain.chain).toHaveLength(2);
    expect(chain.chain.map((r) => r.level)).toEqual([1, 2]);
    expect(chain.chain.map((r) => r.approver_id)).toEqual([ALICE, BOB]);
    // Only the first level's approver is notified at submit.
    expect(stagedEvents.filter((e) => e.topic === 'approval.requested')).toHaveLength(1);
    expect(stagedEvents[0].payload).toMatchObject({ level: 1, recipientUserId: ALICE });

    // DECIDE L1 (Alice approves): chain advances, report stays in APPROVALS, L2 now notified.
    const r1 = await owner.decide(ALICE, ApprovalDecision.Approved);
    expect(r1.completed).toBe(false);
    expect(owner.getStatus()).toBe(ExpenseReportStatus.Approvals);
    expect(stagedEvents.filter((e) => e.topic === 'approval.requested')).toHaveLength(2);
    expect(stagedEvents[1].payload).toMatchObject({ level: 2, recipientUserId: BOB });

    // DECIDE L2 (Bob approves): chain completes approved → exactly one ApprovalCompleted → APPROVED.
    const r2 = await owner.decide(BOB, ApprovalDecision.Approved);
    expect(r2.completed).toBe(true);
    expect(r2.outcome).toBe('approved');
    expect(owner.getStatus()).toBe(ExpenseReportStatus.Approved);

    const completed = stagedEvents.filter((e) => e.topic === 'approval.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].payload).toMatchObject({
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: REPORT,
      outcome: 'approved',
      decidedBy: BOB,
    });
  });

  it('SoD: the requester is excluded from the chain (cannot approve their own report)', async () => {
    // Both Carol (the submitter) and Bob are named approvers, but excludeRequester drops Carol.
    await seedPolicy({
      config: {
        excludeRequester: true,
        levels: [
          { level: 1, source: ApproverSource.User, approver_type: ApproverType.User, approver_id: CAROL },
          { level: 1, source: ApproverSource.User, approver_type: ApproverType.User, approver_id: BOB },
        ],
      },
    });
    const owner = new ExpenseOwner(buildEngine(), REPORT, 20_00, USD, CAROL);

    const chain = await owner.submit();
    // Carol (the requester) is gone; only Bob remains — the SoD invariant.
    expect(chain.chain.map((r) => r.approver_id)).toEqual([BOB]);

    // And the engine refuses a decision from the excluded requester (not a pending approver → 403).
    await expect(owner.decide(CAROL, ApprovalDecision.Approved)).rejects.toMatchObject({
      type: 'forbidden',
    });

    // Bob (the legitimate approver) clears it → APPROVED.
    const r = await owner.decide(BOB, ApprovalDecision.Approved);
    expect(r.completed).toBe(true);
    expect(owner.getStatus()).toBe(ExpenseReportStatus.Approved);
  });

  it('amount-threshold level inclusion: a senior tier is added only above its lower bound', async () => {
    // L1 (manager) always applies; L2 (senior/finance) is gated to amounts >= 1000_00 minor units.
    const policy: Partial<ApprovalShape.PolicyRow> = {
      mode: ApprovalMode.Sequential,
      min_approvals: 2,
      config: {
        levels: [
          { level: 1, source: ApproverSource.User, approver_type: ApproverType.User, approver_id: ALICE },
          {
            level: 2,
            source: ApproverSource.User,
            approver_type: ApproverType.User,
            approver_id: BOB,
            amountMinorMin: 1000_00,
          },
        ],
      },
    };

    // Small report (50.00) — under threshold → ONLY L1 (manager) is on the chain.
    await seedPolicy(policy);
    const small = new ExpenseOwner(buildEngine(), 'report-small', 50_00, USD, CAROL);
    const smallChain = await small.submit();
    expect(smallChain.chain.map((r) => r.approver_id)).toEqual([ALICE]);
    // One approval clears the whole (single-level) chain → APPROVED.
    await small.decide(ALICE, ApprovalDecision.Approved);
    expect(small.getStatus()).toBe(ExpenseReportStatus.Approved);

    // Large report (2000.00) in a FRESH tenant context — over threshold → BOTH levels included.
    freshContext();
    stagedEvents.length = 0;
    await seedPolicy(policy);
    const large = new ExpenseOwner(buildEngine(), 'report-large', 2000_00, USD, CAROL);
    const largeChain = await large.submit();
    expect(largeChain.chain.map((r) => r.approver_id)).toEqual([ALICE, BOB]);
    // Needs BOTH levels: L1 alone leaves it in APPROVALS; L2 completes it.
    await large.decide(ALICE, ApprovalDecision.Approved);
    expect(large.getStatus()).toBe(ExpenseReportStatus.Approvals);
    await large.decide(BOB, ApprovalDecision.Approved);
    expect(large.getStatus()).toBe(ExpenseReportStatus.Approved);
  });

  it('reject short-circuits the chain: a single rejection drives the report to REJECTED', async () => {
    await seedPolicy({
      mode: ApprovalMode.Sequential,
      min_approvals: 2,
      config: {
        levels: [
          { level: 1, source: ApproverSource.User, approver_type: ApproverType.User, approver_id: ALICE },
          { level: 2, source: ApproverSource.User, approver_type: ApproverType.User, approver_id: BOB },
        ],
      },
    });
    const owner = new ExpenseOwner(buildEngine(), REPORT, 75_00, USD, CAROL);
    await owner.submit();

    const r = await owner.decide(ALICE, ApprovalDecision.Rejected);
    expect(r.completed).toBe(true);
    expect(r.outcome).toBe('rejected');
    expect(owner.getStatus()).toBe(ExpenseReportStatus.Rejected);

    // The downstream level was skipped (Bob never had to act), and exactly one completion fired.
    const status = await buildEngineStatus(owner.reportId);
    expect(status.chain.find((row) => row.approver_id === BOB)?.status).toBe(
      RecordApproverStatus.Skipped,
    );
    expect(stagedEvents.filter((e) => e.topic === 'approval.completed')).toHaveLength(1);
  });
});

/** Read the live engine chain for a record (a fresh engine over the same in-memory tables). */
async function buildEngineStatus(reportId: string): Promise<ApprovalShape.ChainStatus> {
  return buildEngine().getStatus(ApprovalRecordType.ExpenseReport, reportId);
}
