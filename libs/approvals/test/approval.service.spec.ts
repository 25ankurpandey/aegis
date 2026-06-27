import type { Transaction } from 'sequelize';
import {
  ApprovalMode,
  ApproverType,
  ApprovalDecision,
  RecordApproverStatus,
} from '@aegis/shared-enums';
import type { ApprovalShape } from '@aegis/shared-types';

/**
 * Engine specs run against an in-memory stand-in for the six approval tables (no Postgres / Docker).
 * The DB seam (`withTenantTransaction`), the model context (`getApprovalContext`), the event seam
 * (`stageOutboxEvent`/`makeEnvelope`), and `RequestContext` are all mocked; the engine, repositories,
 * and resolver run for real on top. This exercises policy resolution, sequential advance, parallel
 * quorum, reject short-circuit, double-vote rejection, completion-event emission, and tenant
 * isolation end-to-end.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TX = 'TX' as unknown as Transaction;

let activeTenant = TENANT_A;

// ---- in-memory model layer -------------------------------------------------------------------

interface Row {
  [k: string]: unknown;
}

/** Records the topics staged to the outbox during a run (the engine's notification/completion seam). */
const stagedEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];

/**
 * A tiny in-memory Sequelize-model stand-in scoped per tenant. Only the methods the repositories use
 * are implemented: create / findAll (where + order) / findByPk / findOne / count / update. Rows are
 * partitioned by `tenant_id` so a query under tenant A never sees tenant B's rows — the in-memory
 * analogue of RLS, which lets us assert tenant isolation without Postgres.
 */
function makeModel() {
  const rows: Row[] = [];
  let seq = 0;

  const matches = (r: Row, where?: Record<string, unknown>): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => r[k] === v);
  };
  const scoped = (where?: Record<string, unknown>) =>
    rows.filter((r) => r['tenant_id'] === activeTenant && matches(r, where));

  const wrap = (r: Row) => ({
    get: (opts?: { plain?: boolean }) => (opts?.plain ? { ...r } : r),
    update: async (patch: Row) => {
      Object.assign(r, patch);
      return wrap(r);
    },
  });

  return {
    _rows: rows,
    create: jest.fn(async (values: Row) => {
      const row: Row = { id: `id-${++seq}`, created_at: new Date(seq), ...values };
      if (row['tenant_id'] === undefined) row['tenant_id'] = activeTenant;
      rows.push(row);
      return wrap(row);
    }),
    findAll: jest.fn(
      async (opts?: { where?: Record<string, unknown>; order?: [string, string][] }) => {
        let out = scoped(opts?.where);
        if (opts?.order) {
          const order = opts.order;
          out = [...out].sort((a, b) => {
            for (const [col, dir] of order) {
              const av = a[col] as number;
              const bv = b[col] as number;
              if (av === bv) continue;
              const cmp = av < bv ? -1 : 1;
              return dir === 'DESC' ? -cmp : cmp;
            }
            return 0;
          });
        }
        return out.map(wrap);
      },
    ),
    findOne: jest.fn(
      async (opts?: { where?: Record<string, unknown>; order?: [string, string][] }) => {
        let out = scoped(opts?.where);
        if (opts?.order) {
          const [col, dir] = opts.order[0];
          out = [...out].sort((a, b) => {
            const av = a[col] as number;
            const bv = b[col] as number;
            const cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return dir === 'DESC' ? -cmp : cmp;
          });
        }
        return out[0] ? wrap(out[0]) : null;
      },
    ),
    findByPk: jest.fn(async (id: string) => {
      const r = scoped().find((x) => x['id'] === id);
      return r ? wrap(r) : null;
    }),
    count: jest.fn(async (opts?: { where?: Record<string, unknown> }) => scoped(opts?.where).length),
    update: jest.fn(
      async (patch: Row, opts: { where: Record<string, unknown> }) => {
        const targets = scoped(opts.where);
        targets.forEach((r) => Object.assign(r, patch));
        return [targets.length];
      },
    ),
  };
}

let ctx: {
  Policy: ReturnType<typeof makeModel>;
  Hierarchy: ReturnType<typeof makeModel>;
  Group: ReturnType<typeof makeModel>;
  GroupMember: ReturnType<typeof makeModel>;
  RecordApprover: ReturnType<typeof makeModel>;
  Vote: ReturnType<typeof makeModel>;
  sequelize: { query: jest.Mock };
};

function freshContext() {
  const Policy = makeModel();
  const Hierarchy = makeModel();
  const Group = makeModel();
  const GroupMember = makeModel();
  const RecordApprover = makeModel();
  const Vote = makeModel();
  // The advisory-lock path (BUG-0004) issues a raw SELECT pg_advisory_xact_lock(...) against the
  // connection; in-memory there is no Postgres, so the query is a no-op spy.
  const sequelize = { query: jest.fn(async () => [{}]) };
  ctx = { Policy, Hierarchy, Group, GroupMember, RecordApprover, Vote, sequelize };
}

// ---- module mocks ----------------------------------------------------------------------------

jest.mock('@aegis/db', () => ({
  withTenantTransaction: jest.fn(async (fn: (t: Transaction) => Promise<unknown>) => fn(TX)),
}));

jest.mock('@aegis/service-core', () => {
  const ErrorType = {
    Forbidden: 'forbidden',
    NotFound: 'not_found',
    Conflict: 'conflict',
  } as const;
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
  EventTopic: { ApprovalRequested: 'approval.requested', ApprovalCompleted: 'approval.completed' },
  makeEnvelope: (topic: string, payload: Record<string, unknown>) => ({ topic, payload }),
  stageOutboxEvent: jest.fn(async (env: { topic: string; payload: Record<string, unknown> }) => {
    stagedEvents.push({ topic: env.topic, payload: env.payload });
  }),
}));

jest.mock('../src/models/database-context', () => ({
  getApprovalContext: () => ctx,
  resetApprovalContext: () => undefined,
}));

// Imported AFTER the mocks so the engine + repos bind to the mocked seams.
import { ApprovalService } from '../src/approval.service';
import { PolicyRepository } from '../src/repositories/policy.repository';
import { RecordApproverRepository } from '../src/repositories/record-approver.repository';
import { VoteRepository } from '../src/repositories/vote.repository';

function buildEngine(): ApprovalService {
  return new ApprovalService(
    new PolicyRepository(),
    new RecordApproverRepository(),
    new VoteRepository(),
  );
}

/** Seed a policy row directly into the in-memory Policy table for the active tenant. */
async function seedPolicy(p: Partial<ApprovalShape.PolicyRow>): Promise<void> {
  await ctx.Policy.create({
    tenant_id: activeTenant,
    record_type: 'expense_report',
    name: 'std',
    mode: ApprovalMode.Sequential,
    min_approvals: 1,
    is_active: true,
    config: {},
    ...p,
  } as Row);
}

const REC = 'rec-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';

function userLevels(...ids: string[]): ApprovalShape.PolicyLevelSpec[] {
  return ids.map((id, i) => ({ level: i + 1, approver_type: ApproverType.User, approver_id: id }));
}

beforeEach(() => {
  activeTenant = TENANT_A;
  stagedEvents.length = 0;
  freshContext();
});

// ---- specs -----------------------------------------------------------------------------------

describe('ApprovalService.requestApproval — policy resolution + chain materialisation', () => {
  it('resolves the active policy and writes a single-level chain', async () => {
    await seedPolicy({ config: { levels: userLevels(ALICE) } });
    const engine = buildEngine();

    const res = await engine.requestApproval({
      recordType: 'expense_report',
      recordId: REC,
      requestedBy: BOB,
    });

    expect(res.mode).toBe(ApprovalMode.Sequential);
    expect(res.chain).toHaveLength(1);
    expect(res.chain[0]).toMatchObject({
      level: 1,
      approver_id: ALICE,
      status: RecordApproverStatus.Pending,
    });
    // The first-level approver is notified.
    expect(stagedEvents.filter((e) => e.topic === 'approval.requested')).toHaveLength(1);
  });

  it('falls back to a default single-level policy when none is configured (empty chain auto-approves)', async () => {
    const engine = buildEngine();
    const res = await engine.requestApproval({
      recordType: 'expense_report',
      recordId: REC,
      requestedBy: BOB,
    });
    // No configured levels → empty chain → immediate completion.
    expect(res.chain).toHaveLength(0);
    expect(stagedEvents.some((e) => e.topic === 'approval.completed' && e.payload['outcome'] === 'approved')).toBe(true);
  });

  it('is idempotent: re-requesting returns the existing chain without duplicating slots', async () => {
    await seedPolicy({ config: { levels: userLevels(ALICE, BOB) } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: CAROL });
    const second = await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: CAROL });
    expect(second.chain).toHaveLength(2);
    expect(ctx.RecordApprover._rows).toHaveLength(2);
  });

  it('SoD hook: excludeRequester drops the requester from the chain', async () => {
    await seedPolicy({ config: { levels: userLevels(ALICE, BOB), excludeRequester: true } });
    const engine = buildEngine();
    const res = await engine.requestApproval({
      recordType: 'expense_report',
      recordId: REC,
      requestedBy: ALICE,
    });
    expect(res.chain.map((r) => r.approver_id)).toEqual([BOB]);
  });
});

describe('ApprovalService.decide — sequential chain advance', () => {
  it('advances level by level and completes only after the final level approves', async () => {
    await seedPolicy({ mode: ApprovalMode.Sequential, min_approvals: 2, config: { levels: userLevels(ALICE, BOB) } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: CAROL });

    // Level 1 approves → not complete; level 2 now notified.
    const r1 = await engine.decide({
      recordType: 'expense_report',
      recordId: REC,
      approverId: ALICE,
      decision: ApprovalDecision.Approved,
    });
    expect(r1.completed).toBe(false);
    expect(stagedEvents.filter((e) => e.topic === 'approval.requested')).toHaveLength(2); // L1 at request + L2 on advance

    // Level 2 approves → complete (approved).
    const r2 = await engine.decide({
      recordType: 'expense_report',
      recordId: REC,
      approverId: BOB,
      decision: ApprovalDecision.Approved,
    });
    expect(r2.completed).toBe(true);
    expect(r2.outcome).toBe('approved');
  });
});

describe('ApprovalService.decide — parallel min_approvals quorum', () => {
  it('completes once min_approvals approvals are recorded, regardless of remaining slots', async () => {
    await seedPolicy({
      mode: ApprovalMode.Parallel,
      min_approvals: 2,
      config: { levels: [
        { level: 1, approver_type: ApproverType.User, approver_id: ALICE },
        { level: 1, approver_type: ApproverType.User, approver_id: BOB },
        { level: 1, approver_type: ApproverType.User, approver_id: CAROL },
      ] },
    });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: 'user-dan' });

    const first = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved });
    expect(first.completed).toBe(false);

    const second = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: BOB, decision: ApprovalDecision.Approved });
    expect(second.completed).toBe(true);
    expect(second.outcome).toBe('approved');
    // Carol's slot was skipped on completion.
    const status = await engine.getStatus('expense_report', REC);
    expect(status.chain.find((r) => r.approver_id === CAROL)?.status).toBe(RecordApproverStatus.Skipped);
  });
});

describe('ApprovalService.decide — reject short-circuit', () => {
  it('a single rejection completes the chain as rejected and skips remaining slots', async () => {
    await seedPolicy({ mode: ApprovalMode.Sequential, min_approvals: 2, config: { levels: userLevels(ALICE, BOB) } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: CAROL });

    const res = await engine.decide({
      recordType: 'expense_report',
      recordId: REC,
      approverId: ALICE,
      decision: ApprovalDecision.Rejected,
    });
    expect(res.completed).toBe(true);
    expect(res.outcome).toBe('rejected');
    const status = await engine.getStatus('expense_report', REC);
    expect(status.chain.find((r) => r.approver_id === BOB)?.status).toBe(RecordApproverStatus.Skipped);
    expect(stagedEvents.some((e) => e.topic === 'approval.completed' && e.payload['outcome'] === 'rejected')).toBe(true);
  });
});

describe('ApprovalService.decide — double-vote rejection', () => {
  it('rejects a second vote by the same approver at the same level', async () => {
    await seedPolicy({ mode: ApprovalMode.Parallel, min_approvals: 3, config: { levels: [
      { level: 1, approver_type: ApproverType.User, approver_id: ALICE },
      { level: 1, approver_type: ApproverType.User, approver_id: BOB },
      { level: 1, approver_type: ApproverType.User, approver_id: CAROL },
    ] } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: 'user-dan' });

    await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved });
    await expect(
      engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved }),
    ).rejects.toMatchObject({ type: 'conflict' });
  });

  it('rejects a decision from a principal who is not an approver for the record', async () => {
    await seedPolicy({ config: { levels: userLevels(ALICE) } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: BOB });
    await expect(
      engine.decide({ recordType: 'expense_report', recordId: REC, approverId: CAROL, decision: ApprovalDecision.Approved }),
    ).rejects.toMatchObject({ type: 'forbidden' });
  });
});

describe('ApprovalService — ApprovalCompleted emission', () => {
  it('emits exactly one ApprovalCompleted carrying the canonical record key + outcome', async () => {
    await seedPolicy({ config: { levels: userLevels(ALICE) } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: BOB });
    await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved });

    const completed = stagedEvents.filter((e) => e.topic === 'approval.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].payload).toMatchObject({
      recordType: 'expense_report',
      recordId: REC,
      outcome: 'approved',
      decidedBy: ALICE,
    });
  });
});

describe('ApprovalService — tenant isolation', () => {
  it('a chain created under tenant A is invisible under tenant B', async () => {
    await seedPolicy({ config: { levels: userLevels(ALICE) } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: BOB });

    // Switch tenant: the same record key has no chain for tenant B.
    activeTenant = TENANT_B;
    const status = await engine.getStatus('expense_report', REC);
    expect(status.chain).toHaveLength(0);

    // And tenant B cannot decide on tenant A's record (no chain → not found).
    await expect(
      engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved }),
    ).rejects.toMatchObject({ type: 'not_found' });
  });
});
