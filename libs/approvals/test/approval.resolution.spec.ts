import type { Transaction } from 'sequelize';
import {
  ApprovalMode,
  ApproverType,
  ApproverSource,
  ApprovalDecision,
  RecordApproverStatus,
} from '@aegis/shared-enums';
import type { ApprovalShape } from '@aegis/shared-types';

/**
 * Full-resolution specs for the approval engine (W3-02..W3-08): amount-threshold levels, manager /
 * manager-chain resolution, approver-group expansion + quorum, mixed sequential/parallel levels, and
 * the supersede/reassign vote ledger. Runs against the same in-memory six-table stand-in the
 * foundation spec uses (no Postgres / Docker); the DB, event, and request-context seams are mocked
 * and the engine + repositories + resolver run for real on top.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TX = 'TX' as unknown as Transaction;
let activeTenant = TENANT_A;

interface Row {
  [k: string]: unknown;
}

const stagedEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];

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
    update: jest.fn(async (patch: Row, opts: { where: Record<string, unknown> }) => {
      const targets = scoped(opts.where);
      targets.forEach((r) => Object.assign(r, patch));
      return [targets.length];
    }),
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
  ctx = {
    Policy: makeModel(),
    Hierarchy: makeModel(),
    Group: makeModel(),
    GroupMember: makeModel(),
    RecordApprover: makeModel(),
    Vote: makeModel(),
    // The advisory-lock path (BUG-0004) issues a raw SELECT pg_advisory_xact_lock(...) against the
    // connection; in-memory there is no Postgres, so the query is a no-op spy.
    sequelize: { query: jest.fn(async () => [{}]) },
  };
}

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

import { ApprovalService } from '../src/approval.service';
import { PolicyRepository } from '../src/repositories/policy.repository';
import { RecordApproverRepository } from '../src/repositories/record-approver.repository';
import { VoteRepository } from '../src/repositories/vote.repository';
import { HierarchyRepository } from '../src/repositories/hierarchy.repository';
import { ApproverGroupRepository } from '../src/repositories/approver-group.repository';
import { LockRepository } from '../src/repositories/lock.repository';
import { PolicyApproverResolver, thresholdApplies } from '../src/resolver';

function buildEngine(): ApprovalService {
  return new ApprovalService(
    new PolicyRepository(),
    new RecordApproverRepository(),
    new VoteRepository(),
    new HierarchyRepository(),
    new ApproverGroupRepository(),
  );
}

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

/** Seed a manager edge user_id → manager_id. */
async function seedEdge(userId: string, managerId: string | null): Promise<void> {
  await ctx.Hierarchy.create({ tenant_id: activeTenant, user_id: userId, manager_id: managerId, depth: 0 } as Row);
}

/** Seed a group + its user members; returns the group id. */
async function seedGroup(groupId: string, memberIds: string[]): Promise<void> {
  await ctx.Group.create({ id: groupId, tenant_id: activeTenant, name: groupId, is_active: true } as Row);
  for (const m of memberIds) {
    await ctx.GroupMember.create({
      tenant_id: activeTenant,
      group_id: groupId,
      member_type: 'user',
      member_id: m,
    } as Row);
  }
}

const REC = 'rec-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';
const DAVE = 'user-dave';
const MGR = 'user-mgr';
const SENIOR = 'user-senior';

function ctxFor(overrides: Partial<ApprovalShape.ResolveContext> = {}): ApprovalShape.ResolveContext {
  return {
    tenantId: activeTenant,
    recordType: 'expense_report',
    recordId: REC,
    requestedBy: BOB,
    policy: { id: 'p', tenant_id: activeTenant, record_type: 'expense_report', name: 'p', mode: ApprovalMode.Sequential, min_approvals: 1, is_active: true, config: {} },
    ...overrides,
  };
}

beforeEach(() => {
  activeTenant = TENANT_A;
  stagedEvents.length = 0;
  freshContext();
});

// ---- W3-03 amount thresholds -----------------------------------------------------------------

describe('W3-03 thresholdApplies', () => {
  it('a level with no bounds always applies', () => {
    expect(thresholdApplies({ level: 1 }, ctxFor())).toBe(true);
  });
  it('includes a min-gated level only when amount >= min', () => {
    const spec = { level: 1, amountMinorMin: 1_000_000 };
    expect(thresholdApplies(spec, ctxFor({ amountMinor: 1_500_000 }))).toBe(true);
    expect(thresholdApplies(spec, ctxFor({ amountMinor: 500_000 }))).toBe(false);
  });
  it('excludes a min-gated level when the amount is unknown (conservative)', () => {
    expect(thresholdApplies({ level: 1, amountMinorMin: 1000 }, ctxFor({ amountMinor: undefined }))).toBe(false);
  });
  it('honours an upper bound (half-open: amount < max)', () => {
    const spec = { level: 1, amountMinorMax: 1000 };
    expect(thresholdApplies(spec, ctxFor({ amountMinor: 999 }))).toBe(true);
    expect(thresholdApplies(spec, ctxFor({ amountMinor: 1000 }))).toBe(false);
  });
  it('a currency-scoped gate only applies for the matching currency', () => {
    const spec = { level: 1, amountMinorMin: 100, currency: 'USD' };
    expect(thresholdApplies(spec, ctxFor({ amountMinor: 200, currency: 'USD' }))).toBe(true);
    expect(thresholdApplies(spec, ctxFor({ amountMinor: 200, currency: 'EUR' }))).toBe(false);
  });
});

describe('W3-03 threshold levels in the resolved chain', () => {
  it('adds a senior level only when the amount crosses the threshold', async () => {
    await seedPolicy({
      mode: ApprovalMode.Sequential,
      config: {
        levels: [
          { level: 1, source: ApproverSource.User, approver_id: ALICE },
          { level: 2, source: ApproverSource.User, approver_id: SENIOR, amountMinorMin: 1_000_000 },
        ],
      },
    });
    const engine = buildEngine();

    const small = await engine.requestApproval({ recordType: 'expense_report', recordId: 'small', amountMinor: 500_000, requestedBy: BOB });
    expect(small.chain.map((r) => r.approver_id)).toEqual([ALICE]);

    const big = await engine.requestApproval({ recordType: 'expense_report', recordId: 'big', amountMinor: 2_000_000, requestedBy: BOB });
    expect(big.chain.map((r) => r.approver_id)).toEqual([ALICE, SENIOR]);
  });
});

// ---- W3-05 manager / manager-chain -----------------------------------------------------------

describe('W3-05 manager resolution', () => {
  it('resolves a manager-source level to the requester reporting manager', async () => {
    await seedEdge(BOB, MGR);
    await seedPolicy({ config: { levels: [{ level: 1, source: ApproverSource.Manager }] } });
    const engine = buildEngine();
    const res = await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: BOB });
    expect(res.chain.map((r) => r.approver_id)).toEqual([MGR]);
    expect(res.chain[0].approver_type).toBe(ApproverType.User);
  });

  it('resolves a manager_chain to N managers up, nearest first', async () => {
    await seedEdge(BOB, MGR);
    await seedEdge(MGR, SENIOR);
    await seedEdge(SENIOR, null);
    await seedPolicy({ config: { levels: [{ level: 1, source: ApproverSource.ManagerChain, depth: 3 }] } });
    const engine = buildEngine();
    const res = await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: BOB });
    expect(res.chain.map((r) => r.approver_id)).toEqual([MGR, SENIOR]);
  });

  it('drops a manager level that resolves to nobody (no edge)', async () => {
    await seedPolicy({ config: { levels: [
      { level: 1, source: ApproverSource.Manager },
      { level: 2, source: ApproverSource.User, approver_id: ALICE },
    ] } });
    const engine = buildEngine();
    const res = await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: BOB });
    // The empty manager level is dropped and levels renumber contiguously.
    expect(res.chain).toHaveLength(1);
    expect(res.chain[0]).toMatchObject({ level: 1, approver_id: ALICE });
  });
});

// ---- W3-04 group expansion + quorum ----------------------------------------------------------

describe('W3-04 approver-group expansion', () => {
  it('expands a group-source level to its user members (any one can clear, default quorum)', async () => {
    await seedGroup('grp-fin', [ALICE, BOB, CAROL]);
    await seedPolicy({ mode: ApprovalMode.Parallel, config: { levels: [
      { level: 1, source: ApproverSource.Group, approver_id: 'grp-fin' },
    ] } });
    const engine = buildEngine();
    const res = await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: DAVE });
    expect(res.chain.map((r) => r.approver_id).sort()).toEqual([ALICE, BOB, CAROL].sort());

    // Any single member clears the level (default per-level quorum = 1).
    const d = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: BOB, decision: ApprovalDecision.Approved });
    expect(d.completed).toBe(true);
    expect(d.outcome).toBe('approved');
  });

  it('honours a group level min_approvals quorum (2 of 3)', async () => {
    await seedGroup('grp-fin', [ALICE, BOB, CAROL]);
    await seedPolicy({ config: { levels: [
      { level: 1, source: ApproverSource.Group, approver_id: 'grp-fin', mode: ApprovalMode.Parallel, min_approvals: 2 },
    ] } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: DAVE });

    const first = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved });
    expect(first.completed).toBe(false);
    const second = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: BOB, decision: ApprovalDecision.Approved });
    expect(second.completed).toBe(true);
  });
});

// ---- W3-08 mixed sequential / parallel -------------------------------------------------------

describe('W3-08 mixed sequential + parallel levels', () => {
  it('level 1 is a parallel quorum, level 2 is a single sequential gate', async () => {
    await seedGroup('grp-l1', [ALICE, BOB, CAROL]);
    await seedPolicy({
      mode: ApprovalMode.Sequential, // policy-wide default; level 1 overrides to parallel
      config: {
        levels: [
          { level: 1, source: ApproverSource.Group, approver_id: 'grp-l1', mode: ApprovalMode.Parallel, min_approvals: 2 },
          { level: 2, source: ApproverSource.User, approver_id: SENIOR },
        ],
      },
    });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: DAVE });

    // Only level-1 approvers are notified at request (sequential advance across levels).
    expect(stagedEvents.filter((e) => e.topic === 'approval.requested')).toHaveLength(3);

    // One level-1 approval is not enough (quorum 2); the chain stays open and level 2 is NOT notified.
    const a = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved });
    expect(a.completed).toBe(false);
    expect(stagedEvents.filter((e) => e.topic === 'approval.requested')).toHaveLength(3);

    // Second level-1 approval clears the quorum → level 2 (Senior) is now notified, chain still open.
    const b = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: BOB, decision: ApprovalDecision.Approved });
    expect(b.completed).toBe(false);
    expect(stagedEvents.filter((e) => e.topic === 'approval.requested')).toHaveLength(4);

    // Carol's now-redundant level-1 slot is skipped; Senior clears level 2 → complete.
    const status1 = await engine.getStatus('expense_report', REC);
    expect(status1.chain.find((r) => r.approver_id === CAROL)?.status).toBe(RecordApproverStatus.Skipped);

    const c = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: SENIOR, decision: ApprovalDecision.Approved });
    expect(c.completed).toBe(true);
    expect(c.outcome).toBe('approved');
  });
});

// ---- W3-06 supersede / reassign --------------------------------------------------------------

describe('W3-06 reassign + unified vote ledger', () => {
  it('reassign retires the prior slot (superseded, inactive) and routes to the new approver, preserving history', async () => {
    await seedPolicy({ config: { levels: [{ level: 1, source: ApproverSource.User, approver_id: ALICE }] } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: DAVE });

    await engine.reassign({ recordType: 'expense_report', recordId: REC, fromApproverId: ALICE, toApproverId: BOB, reassignedBy: DAVE });

    const status = await engine.getStatus('expense_report', REC);
    // The live chain shows only Bob now.
    expect(status.chain.map((r) => r.approver_id)).toEqual([BOB]);
    expect(status.chain[0].status).toBe(RecordApproverStatus.Pending);
    // History keeps Alice's superseded slot pointing at Bob's replacement.
    const aliceRow = status.history.find((r) => r.approver_id === ALICE);
    expect(aliceRow?.status).toBe(RecordApproverStatus.Superseded);
    expect(aliceRow?.is_active).toBe(false);
    const bobRow = status.chain[0];
    expect(aliceRow?.superseded_by_id).toBe(bobRow.id);

    // The original approver can no longer act; the new one can complete the chain.
    await expect(
      engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved }),
    ).rejects.toMatchObject({ type: 'forbidden' });
    const d = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: BOB, decision: ApprovalDecision.Approved });
    expect(d.completed).toBe(true);
  });

  it('reassign rejects when there is no pending slot for the from-approver', async () => {
    await seedPolicy({ config: { levels: [{ level: 1, source: ApproverSource.User, approver_id: ALICE }] } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: DAVE });
    await expect(
      engine.reassign({ recordType: 'expense_report', recordId: REC, fromApproverId: CAROL, toApproverId: BOB, reassignedBy: DAVE }),
    ).rejects.toMatchObject({ type: 'conflict' });
  });
});

// ---- resolver unit: SoD + back-compat --------------------------------------------------------

describe('PolicyApproverResolver — SoD + legacy back-compat', () => {
  it('excludeRequester drops the requester from an expanded group level', async () => {
    await seedGroup('grp', [ALICE, BOB]);
    const resolver = new PolicyApproverResolver(new HierarchyRepository(), new ApproverGroupRepository(), TX);
    const slots = await resolver.resolve(ctxFor({
      requestedBy: ALICE,
      policy: { ...ctxFor().policy, config: { excludeRequester: true, levels: [{ level: 1, source: ApproverSource.Group, approver_id: 'grp' }] } },
    }));
    expect(slots.map((s) => s.approver_id)).toEqual([BOB]);
  });

  it('infers source from the legacy approver_type when no source is set', async () => {
    const resolver = new PolicyApproverResolver(new HierarchyRepository(), new ApproverGroupRepository(), TX);
    const slots = await resolver.resolve(ctxFor({
      policy: { ...ctxFor().policy, config: { levels: [{ level: 1, approver_type: ApproverType.User, approver_id: ALICE }] } },
    }));
    expect(slots).toEqual([{ level: 1, approver_type: ApproverType.User, approver_id: ALICE, sequence: 1 }]);
  });
});

// ---- BUG-0004 parallel-quorum decide race --------------------------------------------------------

describe('BUG-0004 — parallel-quorum decide serialisation (advisory lock)', () => {
  it('takes a transaction-scoped advisory lock before reading the chain in decide()', async () => {
    await seedPolicy({ config: { levels: [{ level: 1, source: ApproverSource.User, approver_id: ALICE }] } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: DAVE });

    ctx.sequelize.query.mockClear();
    ctx.RecordApprover.findAll.mockClear();

    await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved });

    // The lock query ran, and it ran BEFORE the chain was read (serialised view).
    expect(ctx.sequelize.query).toHaveBeenCalledTimes(1);
    const lockSql = ctx.sequelize.query.mock.calls[0][0] as string;
    expect(lockSql).toContain('pg_advisory_xact_lock');
    const lockOrder = ctx.sequelize.query.mock.invocationCallOrder[0];
    const firstReadOrder = ctx.RecordApprover.findAll.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(firstReadOrder);
  });

  it('two approvers on a min_approvals=2 parallel level → exactly one completion, quorum met', async () => {
    await seedPolicy({
      mode: ApprovalMode.Parallel,
      min_approvals: 2,
      config: {
        levels: [
          { level: 1, approver_type: ApproverType.User, approver_id: ALICE, mode: ApprovalMode.Parallel, min_approvals: 2 },
          { level: 1, approver_type: ApproverType.User, approver_id: BOB, mode: ApprovalMode.Parallel, min_approvals: 2 },
          { level: 1, approver_type: ApproverType.User, approver_id: CAROL, mode: ApprovalMode.Parallel, min_approvals: 2 },
        ],
      },
    });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: DAVE });

    // The advisory lock forces the two concurrent votes to serialise; under that serial order the
    // first sees quorum unmet and the second sees quorum met — exactly one completion.
    const lockCallsBefore = ctx.sequelize.query.mock.calls.length;
    const first = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: ALICE, decision: ApprovalDecision.Approved });
    const second = await engine.decide({ recordType: 'expense_report', recordId: REC, approverId: BOB, decision: ApprovalDecision.Approved });

    expect(first.completed).toBe(false);
    expect(second.completed).toBe(true);
    expect(second.outcome).toBe('approved');

    // Quorum met and the chain completed EXACTLY once (no double ApprovalCompleted / double ERP push).
    const completed = stagedEvents.filter((e) => e.topic === 'approval.completed');
    expect(completed).toHaveLength(1);

    // Each serialised decide acquired the per-record lock.
    expect(ctx.sequelize.query.mock.calls.length - lockCallsBefore).toBe(2);
  });
});

describe('BUG-0004 — LockRepository advisory-lock query shape', () => {
  it('issues pg_advisory_xact_lock(hashtextextended(...)) keyed on (record_type, record_id)', async () => {
    const lock = new LockRepository();
    await lock.acquireRecordLock('expense_report', 'rec-xyz', TX);
    expect(ctx.sequelize.query).toHaveBeenCalledTimes(1);
    const [sql, opts] = ctx.sequelize.query.mock.calls[0] as [string, { bind: unknown[]; transaction: unknown }];
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('hashtextextended');
    expect(opts.bind[0]).toBe('expense_report:rec-xyz');
    expect(opts.transaction).toBe(TX);
  });
});

// ---- BUG-0006 reassign duplicate slot ------------------------------------------------------------

describe('BUG-0006 — reassign rejects a duplicate live slot at the level', () => {
  it('reassigning to an approver who already holds a live slot at the level → conflict, no duplicate', async () => {
    // Level 1 is a parallel level with both Alice and Bob already live.
    await seedPolicy({
      mode: ApprovalMode.Parallel,
      min_approvals: 2,
      config: {
        levels: [
          { level: 1, approver_type: ApproverType.User, approver_id: ALICE },
          { level: 1, approver_type: ApproverType.User, approver_id: BOB },
        ],
      },
    });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: DAVE });

    const liveBefore = ctx.RecordApprover._rows.filter((r) => r['is_active'] === true).length;

    await expect(
      engine.reassign({ recordType: 'expense_report', recordId: REC, fromApproverId: ALICE, toApproverId: BOB, reassignedBy: DAVE }),
    ).rejects.toMatchObject({ type: 'conflict' });

    // No duplicate slot was created and Alice's slot was NOT superseded (the reassign was rejected).
    const liveAfter = ctx.RecordApprover._rows.filter((r) => r['is_active'] === true).length;
    expect(liveAfter).toBe(liveBefore);
    const bobLive = ctx.RecordApprover._rows.filter(
      (r) => r['approver_id'] === BOB && r['is_active'] === true && r['level'] === 1,
    );
    expect(bobLive).toHaveLength(1);
  });

  it('still allows reassigning to a fresh approver not already on the level', async () => {
    await seedPolicy({ config: { levels: [{ level: 1, source: ApproverSource.User, approver_id: ALICE }] } });
    const engine = buildEngine();
    await engine.requestApproval({ recordType: 'expense_report', recordId: REC, requestedBy: DAVE });
    const res = await engine.reassign({ recordType: 'expense_report', recordId: REC, fromApproverId: ALICE, toApproverId: CAROL, reassignedBy: DAVE });
    expect(res.chain.map((r) => r.approver_id)).toEqual([CAROL]);
  });
});

// ---- BUG-0007 bigint amount thresholds ----------------------------------------------------------

describe('BUG-0007 — amount thresholds beyond Number.MAX_SAFE_INTEGER', () => {
  const OVER_MAX_SAFE = '9007199254740993'; // MAX_SAFE_INTEGER (…992) + 1, lossy as a JS number
  const THRESHOLD = '9007199254740992'; // MAX_SAFE_INTEGER

  it('thresholdApplies compares in BigInt so an amount just over the threshold routes to the senior level', () => {
    const spec = { level: 1, amountMinorMin: THRESHOLD };
    // Just over the threshold (as a string bigint) → included.
    expect(thresholdApplies(spec, ctxFor({ amountMinor: OVER_MAX_SAFE }))).toBe(true);
    // Exactly one minor unit below → excluded (no lossy Number() rounding to equality).
    expect(thresholdApplies(spec, ctxFor({ amountMinor: '9007199254740991' }))).toBe(false);
  });

  it('accepts bigint amounts and bounds', () => {
    const spec = { level: 1, amountMinorMin: BigInt(THRESHOLD) };
    expect(thresholdApplies(spec, ctxFor({ amountMinor: BigInt(OVER_MAX_SAFE) }))).toBe(true);
    expect(thresholdApplies(spec, ctxFor({ amountMinor: 1n }))).toBe(false);
  });

  it('routes a very large record amount to the senior threshold level end-to-end', async () => {
    await seedPolicy({
      mode: ApprovalMode.Sequential,
      config: {
        levels: [
          { level: 1, source: ApproverSource.User, approver_id: ALICE },
          { level: 2, source: ApproverSource.User, approver_id: SENIOR, amountMinorMin: THRESHOLD },
        ],
      },
    });
    const engine = buildEngine();

    const big = await engine.requestApproval({ recordType: 'expense_report', recordId: 'big', amountMinor: OVER_MAX_SAFE, requestedBy: BOB });
    expect(big.chain.map((r) => r.approver_id)).toEqual([ALICE, SENIOR]);
  });
});
