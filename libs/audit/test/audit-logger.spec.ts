import { Transaction } from 'sequelize';
import { RequestContext } from '@aegis/service-core';
import { getSequelize } from '@aegis/db';
import { AuditAction, AuditOutcome } from '@aegis/shared-enums';
import { AuditLogger } from '../src/audit-logger';
import { getAuditModel } from '../src/audit-log.model';
import { computeAuditHash, GENESIS_HASH, type AuditPayload } from '../src/hash';

// Mock the DB seam so the chain is exercised without a real Postgres connection. Factory mocks keep
// these modules' other exports out of the picture.
jest.mock('@aegis/db', () => ({ getSequelize: jest.fn() }));
jest.mock('../src/audit-log.model', () => ({ getAuditModel: jest.fn() }));
jest.mock('@aegis/service-core', () => ({
  RequestContext: { tenantId: jest.fn(), userId: jest.fn(), roles: jest.fn() },
}));

const mockedGetSequelize = getSequelize as jest.Mock;
const mockedGetAuditModel = getAuditModel as jest.Mock;
const mockedTenantId = RequestContext.tenantId as jest.Mock;
const mockedUserId = RequestContext.userId as jest.Mock;
const mockedRoles = RequestContext.roles as jest.Mock;

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const TX = 'TX' as unknown as Transaction;

type Row = AuditPayload & { id: string; prev_hash: string; hash: string; created_at: number };

/**
 * A tiny in-memory stand-in for the audit_log table plus the per-tenant serialization the appender
 * relies on. `query` honours `pg_advisory_xact_lock` as a real mutex so that — exactly like
 * Postgres — only one critical section per lock key runs at a time; `findOne` returns the live tail.
 */
function makeFakeDb() {
  const rows: Row[] = [];
  let seq = 0;
  const order: string[] = []; // observability: records the order of significant operations

  // Per-key mutex chain emulating pg_advisory_xact_lock held until "commit".
  const locks = new Map<string, Promise<void>>();
  const releases: Array<() => void> = [];

  const query = jest.fn(async (sql: string, opts?: { bind?: unknown[] }) => {
    if (sql.includes('pg_advisory_xact_lock')) {
      const key = JSON.stringify(opts?.bind ?? []);
      const held = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const next = new Promise<void>((r) => (release = r));
      locks.set(key, held.then(() => next));
      releases.push(release);
      order.push('lock');
      await held; // block until any prior holder releases
      return [{}];
    }
    return [];
  });

  const create = jest.fn(async (values: Record<string, unknown>) => {
    order.push('create');
    rows.push({ ...(values as unknown as Row), id: `id-${++seq}`, created_at: seq });
  });

  const findOne = jest.fn(async (_opts: unknown) => {
    order.push('findOne');
    if (rows.length === 0) return null;
    // Tail = max(created_at, id) — same deterministic ordering the appender uses.
    const tail = [...rows].sort((a, b) =>
      b.created_at - a.created_at || (a.id < b.id ? 1 : -1),
    )[0];
    return { get: (k: string) => (tail as unknown as Record<string, unknown>)[k] };
  });

  // "Commit": release the oldest still-held advisory lock, unblocking the next waiter.
  const commit = () => releases.shift()?.();

  mockedGetSequelize.mockReturnValue({ query });
  mockedGetAuditModel.mockReturnValue({ findOne, create });

  return { rows, query, create, findOne, order, commit };
}

const input = (action: AuditAction) => ({ action, outcome: AuditOutcome.Success });

beforeEach(() => {
  mockedTenantId.mockReturnValue(TENANT);
  mockedUserId.mockReturnValue(ACTOR);
  mockedRoles.mockReturnValue(['role.x']);
});

afterEach(() => jest.clearAllMocks());

describe('AuditLogger.record — atomic per-tenant append', () => {
  it('takes the per-tenant advisory lock BEFORE reading the tail, then inserts', async () => {
    const db = makeFakeDb();
    await AuditLogger.record(input(AuditAction.RoleAssigned), TX);
    db.commit();

    // Lock must precede the tail read, which must precede the insert.
    expect(db.order).toEqual(['lock', 'findOne', 'create']);
    expect(db.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1, $2)',
      expect.objectContaining({ bind: expect.arrayContaining([expect.any(Number)]), transaction: TX }),
    );
  });

  it('locks the tail row FOR UPDATE on the same transaction', async () => {
    const db = makeFakeDb();
    await AuditLogger.record(input(AuditAction.RoleAssigned), TX);
    db.commit();

    expect(db.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ transaction: TX, lock: Transaction.LOCK.UPDATE }),
    );
  });

  it('anchors the first entry to GENESIS and chains each subsequent entry', async () => {
    const db = makeFakeDb();

    await AuditLogger.record(input(AuditAction.RoleCreated), TX);
    db.commit();
    await AuditLogger.record(input(AuditAction.RoleAssigned), TX);
    db.commit();

    expect(db.rows).toHaveLength(2);
    expect(db.rows[0].prev_hash).toBe(GENESIS_HASH);
    // Entry 2 chains onto entry 1 — prev_hash equals the previous row's hash.
    expect(db.rows[1].prev_hash).toBe(db.rows[0].hash);
    // And each stored hash is the canonical hash of (prev_hash, payload).
    for (const row of db.rows) {
      expect(row.hash).toBe(computeAuditHash(row.prev_hash, row));
    }
  });

  it('does NOT fork the chain under two concurrent writers (the W1-11 regression)', async () => {
    const db = makeFakeDb();

    // Kick off two appends "simultaneously". The advisory lock must serialize them; we release the
    // first writer's lock (commit) only after both have started, proving the second waits.
    const a = AuditLogger.record(input(AuditAction.RoleCreated), TX);
    const b = AuditLogger.record(input(AuditAction.RoleAssigned), TX);

    // Let the first writer run through to its create, then commit so the second can proceed.
    await Promise.resolve();
    db.commit(); // release writer A's lock → writer B reads A's committed tail
    await a;
    db.commit(); // release writer B's lock
    await b;

    expect(db.rows).toHaveLength(2);
    // Strictly linear chain: exactly one row anchors to GENESIS, the other chains onto it.
    const genesisRows = db.rows.filter((r) => r.prev_hash === GENESIS_HASH);
    expect(genesisRows).toHaveLength(1);
    const [first] = genesisRows;
    const second = db.rows.find((r) => r !== first)!;
    expect(second.prev_hash).toBe(first.hash); // no duplicate prev_hash → no fork
    expect(db.rows.map((r) => r.prev_hash)).toEqual([GENESIS_HASH, first.hash]);
  });
});

describe('AuditLogger.verifyChain', () => {
  it('walks rows in insertion order and reports a valid, well-formed chain', async () => {
    const db = makeFakeDb();
    await AuditLogger.record(input(AuditAction.RoleCreated), TX);
    db.commit();
    await AuditLogger.record(input(AuditAction.RoleAssigned), TX);
    db.commit();

    // findAll returns the rows in created_at ASC order, like the real ordering clause.
    const findAll = jest.fn(async () =>
      [...db.rows]
        .sort((x, y) => x.created_at - y.created_at)
        .map((r) => ({ get: () => r as unknown as Record<string, unknown> })),
    );
    mockedGetAuditModel.mockReturnValue({ findAll });

    await expect(AuditLogger.verifyChain(TX)).resolves.toEqual({ valid: true, count: 2 });
  });

  it('flags the breaking entry when a historical hash is tampered', async () => {
    const db = makeFakeDb();
    await AuditLogger.record(input(AuditAction.RoleCreated), TX);
    db.commit();
    await AuditLogger.record(input(AuditAction.RoleAssigned), TX);
    db.commit();

    db.rows[0].action = 'role.TAMPERED'; // mutate a covered field without re-signing
    const findAll = jest.fn(async () =>
      [...db.rows]
        .sort((x, y) => x.created_at - y.created_at)
        .map((r) => ({ get: () => r as unknown as Record<string, unknown> })),
    );
    mockedGetAuditModel.mockReturnValue({ findAll });

    const result = await AuditLogger.verifyChain(TX);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(db.rows[0].id);
    expect(result.count).toBe(2);
  });
});
