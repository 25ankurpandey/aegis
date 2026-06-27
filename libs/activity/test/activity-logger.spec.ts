import type { Transaction } from 'sequelize';
import { RequestContext } from '@aegis/service-core';
import { ActivityLogger, type ActivityInput } from '../src/activity-logger';
import { getActivityModel } from '../src/activity-log.model';

// Mock the model seam so record/list are exercised without a real Postgres connection. Factory
// mocks keep these modules' other exports out of the picture.
jest.mock('../src/activity-log.model', () => ({ getActivityModel: jest.fn() }));
jest.mock('@aegis/service-core', () => ({
  RequestContext: { tenantId: jest.fn(), userId: jest.fn(), correlationId: jest.fn() },
}));

const mockedGetActivityModel = getActivityModel as jest.Mock;
const mockedTenantId = RequestContext.tenantId as jest.Mock;
const mockedUserId = RequestContext.userId as jest.Mock;
const mockedCorrelationId = RequestContext.correlationId as jest.Mock;

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const RECORD = '33333333-3333-4333-8333-333333333333';
const CORR = 'corr-abc';
const TX = 'TX' as unknown as Transaction;

type Row = {
  id: string;
  tenant_id: string;
  record_type: string;
  record_id: string;
  actor_id: string | null;
  action: string;
  details: unknown;
  correlation_id: string | null;
  created_at: Date;
};

/**
 * A tiny in-memory stand-in for the activity_log table. `create` appends a row; `findAll` emulates
 * the RLS-scoped read by filtering on the tenant that was active at write time plus the requested
 * (record_type, record_id), returned newest-first like the real ordering clause.
 */
function makeFakeDb() {
  const rows: Row[] = [];
  let seq = 0;

  const create = jest.fn(async (values: Record<string, unknown>, _opts: { transaction: Transaction }) => {
    rows.push({
      ...(values as unknown as Omit<Row, 'id' | 'created_at'>),
      id: `id-${++seq}`,
      created_at: new Date(2026, 0, 1, 0, 0, seq),
    });
  });

  const findAll = jest.fn(async (opts: { where: { record_type: string; record_id: string } }) => {
    // RLS would bind tenant_id from the session — emulate it by scoping to the caller's tenant.
    const tenant = mockedTenantId();
    return rows
      .filter(
        (r) =>
          r.tenant_id === tenant &&
          r.record_type === opts.where.record_type &&
          r.record_id === opts.where.record_id,
      )
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1))
      .map((r) => ({ get: () => r as unknown as Record<string, unknown> }));
  });

  mockedGetActivityModel.mockReturnValue({ create, findAll });
  return { rows, create, findAll };
}

const input = (over: Partial<ActivityInput> = {}): ActivityInput => ({
  recordType: 'invoice',
  recordId: RECORD,
  action: 'submitted',
  ...over,
});

beforeEach(() => {
  mockedTenantId.mockReturnValue(TENANT_A);
  mockedUserId.mockReturnValue(ACTOR);
  mockedCorrelationId.mockReturnValue(CORR);
});

afterEach(() => jest.clearAllMocks());

describe('ActivityLogger.record', () => {
  it('stamps the current tenant, actor, and correlation id and inserts on the given tx', async () => {
    const db = makeFakeDb();
    await ActivityLogger.record(input({ details: { amount: 100 } }), TX);

    expect(db.create).toHaveBeenCalledTimes(1);
    const [values, opts] = db.create.mock.calls[0];
    expect(values).toMatchObject({
      tenant_id: TENANT_A,
      record_type: 'invoice',
      record_id: RECORD,
      actor_id: ACTOR,
      action: 'submitted',
      details: { amount: 100 },
      correlation_id: CORR,
    });
    expect(opts).toEqual({ transaction: TX });
  });

  it('honours an explicit actorId / correlationId over the ambient context', async () => {
    const db = makeFakeDb();
    await ActivityLogger.record(input({ actorId: 'explicit-actor', correlationId: 'explicit-corr' }), TX);

    expect(db.rows[0].actor_id).toBe('explicit-actor');
    expect(db.rows[0].correlation_id).toBe('explicit-corr');
  });

  it('defaults details to {} and tolerates a missing ambient user', async () => {
    mockedUserId.mockReturnValue(undefined);
    const db = makeFakeDb();
    await ActivityLogger.record(input(), TX);

    expect(db.rows[0].details).toEqual({});
    expect(db.rows[0].actor_id).toBeNull();
  });
});

describe('ActivityLogger.list', () => {
  it('returns one record\'s timeline newest-first as plain entries', async () => {
    makeFakeDb();
    await ActivityLogger.record(input({ action: 'submitted' }), TX);
    await ActivityLogger.record(input({ action: 'approved' }), TX);

    const timeline = await ActivityLogger.list('invoice', RECORD, TX);
    expect(timeline.map((e) => e.action)).toEqual(['approved', 'submitted']); // newest first
    expect(timeline[0]).toMatchObject({
      tenantId: TENANT_A,
      recordType: 'invoice',
      recordId: RECORD,
      actorId: ACTOR,
    });
    expect(timeline[0].createdAt).toBeInstanceOf(Date);
  });

  it('does not return entries for a different record', async () => {
    makeFakeDb();
    await ActivityLogger.record(input({ recordId: RECORD, action: 'a' }), TX);
    await ActivityLogger.record(input({ recordId: 'other-record', action: 'b' }), TX);

    const timeline = await ActivityLogger.list('invoice', RECORD, TX);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].action).toBe('a');
  });
});

describe('tenant isolation (RLS contract)', () => {
  it('record() stamps each row with the writer\'s own tenant', async () => {
    const db = makeFakeDb();

    mockedTenantId.mockReturnValue(TENANT_A);
    await ActivityLogger.record(input({ action: 'from-a' }), TX);
    mockedTenantId.mockReturnValue(TENANT_B);
    await ActivityLogger.record(input({ action: 'from-b' }), TX);

    expect(db.rows.find((r) => r.action === 'from-a')!.tenant_id).toBe(TENANT_A);
    expect(db.rows.find((r) => r.action === 'from-b')!.tenant_id).toBe(TENANT_B);
  });

  it('list() never leaks another tenant\'s rows for the same record id', async () => {
    makeFakeDb();

    // Tenant A and Tenant B both have activity on the SAME record id.
    mockedTenantId.mockReturnValue(TENANT_A);
    await ActivityLogger.record(input({ action: 'a-only' }), TX);
    mockedTenantId.mockReturnValue(TENANT_B);
    await ActivityLogger.record(input({ action: 'b-only' }), TX);

    // Reading as Tenant B sees only B's entry (RLS scopes the read).
    const asB = await ActivityLogger.list('invoice', RECORD, TX);
    expect(asB.map((e) => e.action)).toEqual(['b-only']);

    // Reading as Tenant A sees only A's entry.
    mockedTenantId.mockReturnValue(TENANT_A);
    const asA = await ActivityLogger.list('invoice', RECORD, TX);
    expect(asA.map((e) => e.action)).toEqual(['a-only']);
  });
});
