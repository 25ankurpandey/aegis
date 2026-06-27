/**
 * Transactional-outbox tests (W2-06). We mock `@aegis/db`'s `getSequelize` with a fake Sequelize so
 * no Postgres is needed. The fake records every query and models transaction semantics:
 *   - `transaction(fn)` runs `fn(t)`; if `fn` throws, the recorded INSERTs are discarded (rollback),
 *     proving the outbox stage is part of the business tx and rolls back WITH it.
 *   - For the relay, the fake serves a canned pending-row SELECT, then records the publish + UPDATE.
 */
import type { Transaction } from 'sequelize';

interface RecordedQuery {
  sql: string;
  bind?: unknown[];
  committed: boolean;
}

class FakeTx {
  committed = false;
}

let recorded: RecordedQuery[] = [];
/** Rows the next pending SELECT should return. */
let pendingRows: unknown[] = [];

const fakeSequelize = {
  async transaction<T>(fn: (t: Transaction) => Promise<T>): Promise<T> {
    const tx = new FakeTx();
    const before = recorded.length;
    try {
      const result = await fn(tx as unknown as Transaction);
      // Commit: mark every query issued in this tx as durable.
      for (let i = before; i < recorded.length; i += 1) recorded[i].committed = true;
      return result;
    } catch (err) {
      // Rollback: drop every query issued in this tx (they never become durable).
      recorded = recorded.slice(0, before);
      throw err;
    }
  },
  async query(sql: string, opts?: { bind?: unknown[] }): Promise<unknown> {
    recorded.push({ sql, bind: opts?.bind, committed: false });
    if (/FROM\s+"event_outbox"/i.test(sql) && /FOR UPDATE SKIP LOCKED/i.test(sql)) {
      return pendingRows;
    }
    if (/set_config/i.test(sql)) return [{ set_config: 'on' }];
    return [];
  },
};

jest.mock('@aegis/db', () => ({
  getSequelize: () => fakeSequelize,
}));

import { stageOutboxEvent, OutboxRelay } from '../src/outbox';
import { makeEnvelope, EventTopic, type EventEnvelope } from '../src/topics';
import { RequestContext } from '@aegis/service-core';

function inTenant<T>(tenantId: string, fn: () => T): T {
  return RequestContext.run(
    { tenantId, correlationId: 'corr-1', sourceService: undefined as never, startedAt: Date.now() },
    fn,
  );
}

function sampleEnvelope(tenantId = 'tenant-A'): EventEnvelope {
  return inTenant(tenantId, () =>
    makeEnvelope(EventTopic.ExpenseApproved, {
      reportId: 'r1',
      status: 'approved',
      approvedBy: 'u1',
      amountMinor: 1000,
      recipientUserId: 'u2',
    }),
  ) as EventEnvelope;
}

beforeEach(() => {
  recorded = [];
  pendingRows = [];
});

describe('stageOutboxEvent (in-transaction staging)', () => {
  it('inserts the staged event as part of the committing transaction', async () => {
    const env = sampleEnvelope();
    await fakeSequelize.transaction(async (t) => {
      await stageOutboxEvent(env, t);
    });
    const insert = recorded.find((q) => /INSERT INTO\s+"event_outbox"/i.test(q.sql));
    expect(insert).toBeDefined();
    expect(insert?.committed).toBe(true); // committed WITH the tx
    expect(insert?.bind?.[0]).toBe(env.id);
    expect(insert?.bind?.[1]).toBe('tenant-A'); // tenant_id from the envelope
    expect(insert?.bind?.[2]).toBe(EventTopic.ExpenseApproved);
  });

  it('rolls back the staged event when the business transaction throws (no dual-write)', async () => {
    const env = sampleEnvelope();
    await expect(
      fakeSequelize.transaction(async (t) => {
        await stageOutboxEvent(env, t);
        throw new Error('business write failed');
      }),
    ).rejects.toThrow('business write failed');
    // The insert was discarded with the rolled-back tx — nothing durable remains.
    expect(recorded.some((q) => /INSERT INTO\s+"event_outbox"/i.test(q.sql))).toBe(false);
  });
});

describe('OutboxRelay (at-least-once drain)', () => {
  it('publishes each pending row to the bus and marks it published', async () => {
    const env = sampleEnvelope();
    pendingRows = [
      { id: env.id, tenant_id: env.tenantId, topic: env.topic, payload: env.payload, envelope: env, status: 'pending', attempts: 0 },
    ];
    const published: EventEnvelope[] = [];
    const bus = { publish: async (e: EventEnvelope) => void published.push(e), subscribe: () => undefined };

    const relay = new OutboxRelay({ bus });
    const count = await relay.drainOnce();

    expect(count).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0].id).toBe(env.id);
    const update = recorded.find((q) => /UPDATE\s+"event_outbox"/i.test(q.sql) && /'published'/i.test(q.sql));
    expect(update).toBeDefined();
    expect(update?.bind?.[0]).toBe(env.id);
  });

  it('marks published only AFTER publish succeeds; a publish failure parks the row, not published', async () => {
    const env = sampleEnvelope();
    pendingRows = [
      { id: env.id, tenant_id: env.tenantId, topic: env.topic, payload: env.payload, envelope: env, status: 'pending', attempts: 4 },
    ];
    const bus = {
      publish: async () => {
        throw new Error('broker down');
      },
      subscribe: () => undefined,
    };

    const relay = new OutboxRelay({ bus, maxAttempts: 5 });
    const count = await relay.drainOnce();

    expect(count).toBe(0); // nothing published
    // No row marked 'published'; the failed row is parked 'failed' (attempts 4 -> 5 == maxAttempts).
    expect(recorded.some((q) => /UPDATE\s+"event_outbox"/i.test(q.sql) && /'published'/i.test(q.sql))).toBe(false);
    const park = recorded.find((q) => /UPDATE\s+"event_outbox"/i.test(q.sql));
    expect(park?.bind).toEqual([env.id, 5, 'failed', 'broker down']);
  });

  // BUG-0003: the poll loop must be ADAPTIVE — a full batch (backlog likely) re-drains promptly
  // instead of idling a full interval; a partial batch falls back to the interval.
  describe('adaptive cadence (start)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function makeRow(id: string) {
      const env = sampleEnvelope();
      return { id, tenant_id: env.tenantId, topic: env.topic, payload: env.payload, envelope: { ...env, id }, status: 'pending', attempts: 0 };
    }

    it('re-drains IMMEDIATELY after a full batch, then waits intervalMs once caught up', async () => {
      const drained: number[] = [];
      // Pass 1: full batch (== batchSize) -> expect a prompt (0ms) re-drain. Pass 2: partial -> interval.
      const passes = [[makeRow('a'), makeRow('b')], [makeRow('c')], []];
      const fakeBus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: () => undefined };

      const relay = new OutboxRelay({ bus: fakeBus, batchSize: 2, intervalMs: 1000 });
      // Feed each pass's rows in order; record how many rows each drain saw.
      const origQuery = fakeSequelize.query;
      const spy = jest
        .spyOn(fakeSequelize, 'query')
        .mockImplementation(async (sql: string, opts?: { bind?: unknown[] }) => {
          if (/FROM\s+"event_outbox"/i.test(sql) && /FOR UPDATE SKIP LOCKED/i.test(sql)) {
            const rows = passes.shift() ?? [];
            drained.push(rows.length);
            return rows;
          }
          return origQuery(sql, opts);
        });

      try {
        relay.start();
        // Pass 1 is armed at intervalMs. Run it: a FULL batch (2 == batchSize) re-arms PROMPTLY (0ms).
        await jest.advanceTimersByTimeAsync(1000);
        expect(drained).toEqual([2]);

        // The prompt 0ms re-arm fires pass 2 without waiting a full interval — this is the adaptive win.
        await jest.runOnlyPendingTimersAsync();
        expect(drained).toEqual([2, 1]); // pass 2 drained the partial backlog promptly

        // Pass 2 was PARTIAL (1 < batchSize) so it re-arms at intervalMs: a short advance must NOT fire it.
        await jest.advanceTimersByTimeAsync(500);
        expect(drained).toEqual([2, 1]); // still idling — no prompt re-drain after a partial batch
        await jest.advanceTimersByTimeAsync(500);
        expect(drained).toEqual([2, 1, 0]); // the interval pass fired at ~1000ms (now empty)

        relay.stop();
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('is idempotent across redrains: republishing the same envelope id is safe (consumers dedupe on id)', async () => {
    const env = sampleEnvelope();
    pendingRows = [
      { id: env.id, tenant_id: env.tenantId, topic: env.topic, payload: env.payload, envelope: env, status: 'pending', attempts: 0 },
    ];
    const published: string[] = [];
    const bus = { publish: async (e: EventEnvelope) => void published.push(e.id), subscribe: () => undefined };

    const relay = new OutboxRelay({ bus });
    await relay.drainOnce();
    // Simulate the SAME row still pending on a second pass (e.g. crash before commit last time).
    pendingRows = [
      { id: env.id, tenant_id: env.tenantId, topic: env.topic, payload: env.payload, envelope: env, status: 'pending', attempts: 0 },
    ];
    await relay.drainOnce();

    // Same envelope id both times — at-least-once with a stable id is what makes consumers idempotent.
    expect(published).toEqual([env.id, env.id]);
  });
});
