/**
 * INTEGRATION (Track B — eventing contract, full pipeline). Proves the cross-service contract
 * end-to-end across a REAL bus rather than asserting one side in isolation:
 *
 *     real ApprovalService  →  stageOutboxEvent (real)  →  OutboxRelay.drainOnce (real)
 *                           →  InProcessBus (real)       →  notification consumer (real)
 *
 * The DB is the only thing mocked: `withTenantTransaction` runs the callback with a fake tx and
 * `getSequelize().query` is backed by an in-memory `event_outbox` array, so the SAME outbox the
 * producer stages into is the one the REAL `OutboxRelay` selects/updates and publishes. Nothing about
 * the topic, the typed payload, the envelope tenant, or the consumer's tenant-from-envelope read is
 * stubbed — so a divergence on EITHER side (producer emits the wrong shape / consumer reads the wrong
 * field) fails here.
 *
 * What it locks in (the "exact EventTopics each consumer subscribes to match producers' typed
 * payloads" + "notification reads tenant from envelope" bullets):
 *   1. the real engine's `requestApproval` stages a typed `ApprovalRequested` whose payload carries
 *      the addressing alias (subjectType/subjectId), the canonical key (recordType/recordId), the
 *      chain level, and the recipient hint — and the notification consumer subscribed to that topic
 *      delivers it with tenant resolved FROM THE ENVELOPE (not the payload);
 *   2. the real engine's `decide` stages a typed `ApprovalCompleted` on chain completion — a topic the
 *      notification consumer does NOT subscribe to, so it is not mis-delivered as a notification.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'sequelize';
import {
  ApprovalDecision,
  ApprovalMode,
  ApproverType,
  ApprovalRecordType,
  RecordApproverStatus,
  NotificationCode,
} from '@aegis/shared-enums';
import type { ApprovalShape } from '@aegis/shared-types';
import { RequestContext } from '@aegis/service-core';

// ---- in-memory outbox table backing the relay's SQL (the only DB seam) -----------------------------
interface OutboxRecord {
  id: string;
  tenant_id: string;
  topic: string;
  payload: unknown;
  envelope: Record<string, unknown>;
  status: 'pending' | 'published' | 'failed';
  attempts: number;
}
const outboxTable: OutboxRecord[] = [];

jest.mock('@aegis/db', () => ({
  withTenantTransaction: <T>(fn: (t: Transaction) => Promise<T>): Promise<T> => fn({} as Transaction),
  getSequelize: () => ({
    // OutboxRelay.drainOnce opens its own sequelize.transaction; run the body with a fake tx.
    transaction: <T>(fn: (t: Transaction) => Promise<T>): Promise<T> => fn({} as Transaction),
    // Faithful enough to back stageOutboxEvent (INSERT) + OutboxRelay.drainOnce (SET/SELECT/UPDATE).
    query: async (sql: string, opts?: { bind?: unknown[] }) => {
      if (/INSERT INTO\s+"event_outbox"/i.test(sql)) {
        const bind = opts?.bind ?? [];
        outboxTable.push({
          id: bind[0] as string,
          tenant_id: bind[1] as string,
          topic: bind[2] as string,
          payload: JSON.parse((bind[3] as string) ?? '{}'),
          envelope: JSON.parse((bind[4] as string) ?? '{}'),
          status: 'pending',
          attempts: 0,
        });
        return [];
      }
      if (/set_config/i.test(sql)) return []; // relay-bypass RLS marker — no-op in-memory
      if (/SELECT[\s\S]+FROM\s+"event_outbox"/i.test(sql)) {
        return outboxTable.filter((r) => r.status === 'pending');
      }
      if (/UPDATE\s+"event_outbox"[\s\S]+status\s*=\s*'published'/i.test(sql)) {
        const id = opts?.bind?.[0];
        const row = outboxTable.find((r) => r.id === id);
        if (row) row.status = 'published';
        return [];
      }
      if (/UPDATE\s+"event_outbox"/i.test(sql)) {
        const [id, attempts, status] = opts?.bind ?? [];
        const row = outboxTable.find((r) => r.id === id);
        if (row) {
          row.attempts = attempts as number;
          row.status = status as OutboxRecord['status'];
        }
        return [];
      }
      return [];
    },
  }),
}));

// AuditLogger / ActivityLogger are out of scope here (covered by their own libs' specs).
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: jest.fn().mockResolvedValue(undefined) } }));

import {
  InProcessBus,
  setBus,
  OutboxRelay,
  makeEnvelope,
  stageOutboxEvent,
  EventTopic,
} from '@aegis/events';
import { ApprovalService } from '@aegis/approvals';
import { container } from '../../src/ioc/container';
import { NotificationService } from '../../src/services/notification.service';
import { registerConsumers } from '../../src/consumers/notification.consumer';

const TENANT = 'tenant-eventing-77';
const RECORD_ID = '22222222-2222-4222-8222-222222222222';
const REQUESTER = 'submitter-1';
const APPROVER = 'approver-1';

function asTenant<T>(fn: () => T, userId = REQUESTER): T {
  return RequestContext.run(
    { tenantId: TENANT, userId, correlationId: 'corr-int', startedAt: Date.now() } as never,
    fn,
  );
}

/**
 * In-memory chain + vote + policy repositories: the SAME methods the real engine calls, backed by JS
 * arrays. This drives the REAL ApprovalService logic (chain materialisation, no-double-vote,
 * completion + the typed event staging) without a database.
 */
function makeChainRepo() {
  const rows: ApprovalShape.RecordApproverRow[] = [];
  return {
    rows,
    async create(data: Partial<ApprovalShape.RecordApproverRow>) {
      const row = { id: randomUUID(), is_active: true, ...data } as ApprovalShape.RecordApproverRow;
      rows.push(row);
      return row;
    },
    async listForRecord(rt: string, rid: string) {
      return rows
        .filter((r) => r.record_type === rt && r.record_id === rid && r.is_active)
        .sort((a, b) => a.level - b.level || a.sequence - b.sequence);
    },
    async listHistoryForRecord(rt: string, rid: string) {
      return rows.filter((r) => r.record_type === rt && r.record_id === rid);
    },
    async listPendingForApprover(approverId: string, rt: string | undefined) {
      return rows.filter(
        (r) =>
          r.approver_id === approverId &&
          r.status === RecordApproverStatus.Pending &&
          r.is_active &&
          (rt === undefined || r.record_type === rt),
      );
    },
    async existsForRecord(rt: string, rid: string) {
      return rows.some((r) => r.record_type === rt && r.record_id === rid && r.is_active);
    },
    async setStatus(id: string, status: RecordApproverStatus) {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = status;
    },
    async skipRemaining(rt: string, rid: string) {
      let n = 0;
      for (const r of rows) {
        if (r.record_type === rt && r.record_id === rid && r.status === RecordApproverStatus.Pending && r.is_active) {
          r.status = RecordApproverStatus.Skipped;
          n += 1;
        }
      }
      return n;
    },
    async skipRemainingAtLevel(rt: string, rid: string, level: number) {
      let n = 0;
      for (const r of rows) {
        if (r.record_type === rt && r.record_id === rid && r.level === level && r.status === RecordApproverStatus.Pending && r.is_active) {
          r.status = RecordApproverStatus.Skipped;
          n += 1;
        }
      }
      return n;
    },
    async supersede(id: string, supersededById: string | null) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = RecordApproverStatus.Superseded;
        row.is_active = false;
        row.superseded_by_id = supersededById;
      }
    },
  };
}

function makeVoteRepo() {
  const votes: ApprovalShape.ApprovalVoteRow[] = [];
  return {
    votes,
    async append(v: Omit<ApprovalShape.ApprovalVoteRow, 'id'>) {
      votes.push({ id: randomUUID(), ...v } as ApprovalShape.ApprovalVoteRow);
    },
    async hasVoted(rt: string, rid: string, level: number, approverId: string) {
      return votes.some(
        (v) => v.record_type === rt && v.record_id === rid && v.level === level && v.approver_id === approverId,
      );
    },
    async listForRecord(rt: string, rid: string) {
      return votes.filter((v) => v.record_type === rt && v.record_id === rid);
    },
  };
}

/** A single-level sequential policy with one user approver — the simplest real chain. */
function makePolicyRepo() {
  const policy: ApprovalShape.PolicyRow = {
    id: 'policy-1',
    tenant_id: TENANT,
    record_type: ApprovalRecordType.ExpenseReport,
    name: 'one-gate',
    mode: ApprovalMode.Sequential,
    min_approvals: 1,
    is_active: true,
    config: {},
  };
  return {
    async findActiveForRecordType() {
      return policy;
    },
  };
}

/** Resolver override (the documented test seam) yielding one pending approver slot at level 1. */
const oneApproverResolver = {
  async resolve(): Promise<ApprovalShape.ResolvedSlot[]> {
    return [{ level: 1, approver_type: ApproverType.User, approver_id: APPROVER, sequence: 1 }];
  },
};

function buildEngine() {
  const chain = makeChainRepo();
  const votes = makeVoteRepo();
  const policies = makePolicyRepo();
  const engine = new ApprovalService(policies as never, chain as never, votes as never);
  engine.useResolver(oneApproverResolver);
  return { engine, chain, votes };
}

describe('eventing contract — real ApprovalService → outbox → relay → InProcessBus → notification consumer', () => {
  let bus: InProcessBus;
  let relay: OutboxRelay;
  let dispatched: Array<{ message: Record<string, unknown>; spec: unknown; ctxTenant: string }>;

  beforeEach(() => {
    // Keep the fail-closed retry path fast + deterministic (the empty-tenant case DLQs after retries).
    process.env.KAFKA_RETRY_MAX = '1';
    process.env.KAFKA_RETRY_DELAY_MS = '1';
    outboxTable.length = 0;
    dispatched = [];

    // A real bus, with the REAL notification consumer subscribed to its real topics.
    bus = new InProcessBus();
    setBus(bus);

    const fakeService = {
      resolveAndDispatch: jest.fn(async (message: Record<string, unknown>, spec: unknown) => {
        dispatched.push({ message, spec, ctxTenant: RequestContext.tenantId() });
      }),
    } as unknown as NotificationService;
    jest.spyOn(container, 'get').mockReturnValue(fakeService);
    registerConsumers();

    // A real relay that drains our in-memory outbox to that same bus.
    relay = new OutboxRelay({ bus });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setBus(new InProcessBus());
  });

  it('requestApproval stages a typed ApprovalRequested the notification consumer delivers with tenant FROM THE ENVELOPE', async () => {
    const { engine } = buildEngine();

    await asTenant(() =>
      engine.requestApproval({
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: RECORD_ID,
        amountMinor: 5000,
        currency: 'USD',
        requestedBy: REQUESTER,
      }),
    );

    // One event staged into the outbox: the typed ApprovalRequested for the first-level approver.
    expect(outboxTable).toHaveLength(1);
    const staged = outboxTable[0];
    expect(staged.topic).toBe(EventTopic.ApprovalRequested);
    expect(staged.tenant_id).toBe(TENANT); // envelope tenant came from the producer's context

    // The producer's typed payload contract (engine-authored ApprovalRequested):
    expect(staged.payload).toMatchObject({
      subjectType: ApprovalRecordType.ExpenseReport,
      subjectId: RECORD_ID,
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: RECORD_ID,
      requestedBy: REQUESTER,
      level: 1,
      recipientUserId: APPROVER, // the addressing hint the notification service consumes
    });

    // Drain the real relay → publishes the staged envelope to the real bus → real consumer runs.
    const published = await relay.drainOnce();
    expect(published).toBe(1);
    expect(staged.status).toBe('published');

    // The consumer subscribed to ApprovalRequested delivered it — under the ENVELOPE's tenant.
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].ctxTenant).toBe(TENANT);
    expect(dispatched[0].spec).toEqual({ kind: 'user', userId: APPROVER, email: undefined });
    expect(dispatched[0].message).toMatchObject({
      code: NotificationCode.ApprovalRequested,
      subjectType: ApprovalRecordType.ExpenseReport,
      subjectId: RECORD_ID,
      requestedBy: REQUESTER,
    });
  });

  it('decide(approve) stages a typed ApprovalCompleted — a topic notification does NOT subscribe to (no mis-delivery)', async () => {
    const { engine } = buildEngine();

    await asTenant(() =>
      engine.requestApproval({
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: RECORD_ID,
        requestedBy: REQUESTER,
      }),
    );
    // Drain + dispatch the ApprovalRequested produced by requesting, then reset capture.
    await relay.drainOnce();
    dispatched = [];

    const result = await asTenant(
      () =>
        engine.decide({
          recordType: ApprovalRecordType.ExpenseReport,
          recordId: RECORD_ID,
          approverId: APPROVER,
          decision: ApprovalDecision.Approved,
        }),
      APPROVER,
    );
    expect(result.completed).toBe(true);
    expect(result.outcome).toBe('approved');

    // A typed ApprovalCompleted was staged with the canonical key + closing approver.
    const completed = outboxTable.find((r) => r.topic === EventTopic.ApprovalCompleted);
    expect(completed).toBeDefined();
    expect(completed?.tenant_id).toBe(TENANT);
    expect(completed?.payload).toMatchObject({
      subjectType: ApprovalRecordType.ExpenseReport,
      subjectId: RECORD_ID,
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: RECORD_ID,
      outcome: 'approved',
      decidedBy: APPROVER,
    });

    // Drain the relay: ApprovalCompleted reaches the bus but notification subscribes to NEITHER it
    // (it maps to workflow, not notifications) — so the notification consumer dispatches nothing new.
    const published = await relay.drainOnce();
    expect(published).toBeGreaterThanOrEqual(1);
    expect(dispatched).toHaveLength(0);
  });

  it('the bus rebuilds the envelope tenant into the consumer context — an empty-tenant envelope fails closed (no dispatch)', async () => {
    // A producer that had NO RequestContext stamps tenantId '' on the envelope (makeEnvelope outside
    // a scope). Publishing it through the real bus rebuilds ctx tenant '' and the consumer's
    // assertEnvelopeTenant throws on the mismatch → retry-then-DLQ, never dispatched (fail-closed).
    process.env.KAFKA_RETRY_MAX = '1';
    process.env.KAFKA_RETRY_DELAY_MS = '1';
    const env = makeEnvelope(EventTopic.ApprovalRequested, {
      approvalId: randomUUID(),
      subjectType: ApprovalRecordType.ExpenseReport,
      subjectId: RECORD_ID,
      requestedBy: REQUESTER,
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: RECORD_ID,
      level: 1,
      recipientUserId: APPROVER,
    });
    expect(env.tenantId).toBe(''); // no producer scope ⇒ empty tenant on the envelope

    await bus.publish(env);

    expect(dispatched).toHaveLength(0);
  });
});

/**
 * The per-domain `*Approved` notification contract: each owning finance service stages a typed
 * notification-bound event (ExpenseApproved / InvoiceApproved / PayRunApproved) carrying a recipient
 * hint; the notification consumer subscribed to that exact topic must render the matching
 * NotificationCode and address the hint — proving "the exact EventTopics each consumer subscribes to
 * match the producers' typed payloads" for the approve-notification half, through the real relay+bus.
 */
describe('per-domain *Approved notification contract — staged → relay → bus → notification consumer', () => {
  let bus: InProcessBus;
  let relay: OutboxRelay;
  let dispatched: Array<{ message: Record<string, unknown>; spec: unknown; ctxTenant: string }>;

  beforeEach(() => {
    process.env.KAFKA_RETRY_MAX = '1';
    process.env.KAFKA_RETRY_DELAY_MS = '1';
    outboxTable.length = 0;
    dispatched = [];
    bus = new InProcessBus();
    setBus(bus);
    const fakeService = {
      resolveAndDispatch: jest.fn(async (message: Record<string, unknown>, spec: unknown) => {
        dispatched.push({ message, spec, ctxTenant: RequestContext.tenantId() });
      }),
    } as unknown as NotificationService;
    jest.spyOn(container, 'get').mockReturnValue(fakeService);
    registerConsumers();
    relay = new OutboxRelay({ bus });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setBus(new InProcessBus());
  });

  /** Stage a typed envelope under a producer context (the owning service's real staging path). */
  async function stageUnderTenant<T extends Parameters<typeof makeEnvelope>[0]>(
    topic: T,
    payload: Parameters<typeof makeEnvelope>[1],
  ): Promise<void> {
    await RequestContext.run(
      { tenantId: TENANT, userId: REQUESTER, correlationId: 'corr-app', startedAt: Date.now() } as never,
      async () => stageOutboxEvent(makeEnvelope(topic as never, payload as never), {} as Transaction),
    );
  }

  it('ExpenseApproved → ExpenseApproved code, addresses the submitter hint, tenant from envelope', async () => {
    await stageUnderTenant(EventTopic.ExpenseApproved, {
      reportId: 'rep-1',
      status: 'approved',
      approvedBy: APPROVER,
      amountMinor: 5000,
      recipientUserId: 'sub-1',
      recipientEmail: 'sub@example.com',
    });

    await relay.drainOnce();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].ctxTenant).toBe(TENANT);
    expect(dispatched[0].spec).toEqual({ kind: 'user', userId: 'sub-1', email: 'sub@example.com' });
    expect(dispatched[0].message).toMatchObject({
      code: NotificationCode.ExpenseApproved,
      reportId: 'rep-1',
      approvedBy: APPROVER,
      amountMinor: 5000,
    });
  });

  it('InvoiceApproved → InvoiceApproved code with vendor + header amount + poReference', async () => {
    await stageUnderTenant(EventTopic.InvoiceApproved, {
      invoiceId: 'inv-9',
      status: 'approved',
      vendorName: 'Acme Supplies',
      amountMinor: 120000,
      poReference: 'PO-42',
      recipientUserId: 'maker-9',
    });

    await relay.drainOnce();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].spec).toEqual({ kind: 'user', userId: 'maker-9', email: undefined });
    expect(dispatched[0].message).toMatchObject({
      code: NotificationCode.InvoiceApproved,
      invoiceId: 'inv-9',
      vendorName: 'Acme Supplies',
      amountMinor: 120000,
      poReference: 'PO-42',
    });
  });

  it('PayRunApproved → PayRunApproved code addressing the run creator', async () => {
    await stageUnderTenant(EventTopic.PayRunApproved, {
      payRunId: 'run-5',
      approvedBy: APPROVER,
      recipientUserId: 'creator-5',
    });

    await relay.drainOnce();

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].spec).toEqual({ kind: 'user', userId: 'creator-5', email: undefined });
    expect(dispatched[0].message).toMatchObject({
      code: NotificationCode.PayRunApproved,
      payRunId: 'run-5',
      approvedBy: APPROVER,
    });
  });
});
