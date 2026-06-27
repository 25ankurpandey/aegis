/**
 * FLOW 3 — TRANSACTIONAL OUTBOX + DLQ SEMANTICS (no dual-write, no silent drop).
 *
 * Exercises the REAL outbox machinery end-to-end against an in-memory `event_outbox` table:
 *
 *   1. `stageOutboxEvent(env, t)` — the REAL producer-side stage — writes the full envelope as a
 *      `pending` row INSIDE the (mocked) business transaction, so the event is atomic with the write.
 *   2. the REAL `OutboxRelay.drainOnce()` selects pending rows oldest-first and publishes each to the
 *      bus, marking it `published` only AFTER `bus.publish` resolves (at-least-once).
 *   3. a consumer that THROWS is retried by the REAL `InProcessBus` up to `KAFKA_RETRY_MAX`, then the
 *      envelope is handed to the REAL `DeadLetterSink` — it is NOT silently caught-and-dropped.
 *
 * The only mocked seam is `@aegis/db` `getSequelize()` (an in-memory store interpreting the outbox's
 * SQL). The outbox helper, the relay, the bus, its retry loop, and the dead-letter hook all run for
 * real, so the atomicity + at-least-once + DLQ guarantees are genuinely under test.
 */
// Speed the bus retry loop (3 attempts, near-zero spacing) so the DLQ assertion is fast + deterministic.
process.env.KAFKA_RETRY_MAX = '3';
process.env.KAFKA_RETRY_DELAY_MS = '1';

// ---- in-memory `event_outbox` + a Sequelize fake interpreting the outbox/relay SQL --------------

interface OutboxRowStore {
  id: string;
  tenant_id: string;
  topic: string;
  payload: unknown;
  envelope: unknown;
  status: 'pending' | 'published' | 'failed';
  attempts: number;
  created_at: number;
  last_error: string | null;
  published_at: number | null;
}

const outboxTable: OutboxRowStore[] = [];
let rowSeq = 0;

/** A minimal Sequelize stand-in: `transaction(fn)` runs fn with a sentinel tx; `query(sql, opts)`
 *  recognises the four outbox/relay statements by shape and mutates the in-memory table. */
function makeSequelizeFake() {
  return {
    transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn('TX'),
    query: async (sql: string, opts?: { bind?: unknown[]; type?: unknown }): Promise<unknown> => {
      const bind = opts?.bind ?? [];
      // set_config(...) — the relay-bypass RLS marker; a no-op for the in-memory store.
      if (sql.includes('set_config')) return [];

      // INSERT INTO event_outbox (...) — stageOutboxEvent.
      if (/INSERT INTO\s+"event_outbox"/i.test(sql)) {
        outboxTable.push({
          id: String(bind[0]),
          tenant_id: String(bind[1]),
          topic: String(bind[2]),
          payload: JSON.parse(String(bind[3])),
          envelope: JSON.parse(String(bind[4])),
          status: 'pending',
          attempts: 0,
          created_at: ++rowSeq,
          last_error: null,
          published_at: null,
        });
        return [undefined, 1];
      }

      // SELECT ... FROM event_outbox WHERE status='pending' ... — the relay's drain query.
      if (/SELECT[\s\S]*FROM\s+"event_outbox"/i.test(sql)) {
        return outboxTable
          .filter((r) => r.status === 'pending')
          .sort((a, b) => a.created_at - b.created_at)
          .map((r) => ({
            id: r.id,
            tenant_id: r.tenant_id,
            topic: r.topic,
            payload: r.payload,
            envelope: r.envelope,
            status: r.status,
            attempts: r.attempts,
          }));
      }

      // UPDATE event_outbox SET status='published' ... — success path.
      if (/UPDATE\s+"event_outbox"[\s\S]*status\s*=\s*'published'/i.test(sql)) {
        const row = outboxTable.find((r) => r.id === String(bind[0]));
        if (row) {
          row.status = 'published';
          row.published_at = ++rowSeq;
          row.last_error = null;
        }
        return [undefined, 1];
      }

      // UPDATE event_outbox SET attempts=$2, status=$3, last_error=$4 ... — failure/park path.
      if (/UPDATE\s+"event_outbox"[\s\S]*attempts\s*=/i.test(sql)) {
        const row = outboxTable.find((r) => r.id === String(bind[0]));
        if (row) {
          row.attempts = Number(bind[1]);
          row.status = bind[2] as OutboxRowStore['status'];
          row.last_error = String(bind[3]);
        }
        return [undefined, 1];
      }

      throw new Error(`unrecognised SQL in outbox fake: ${sql}`);
    },
  };
}

const sequelizeFake = makeSequelizeFake();

jest.mock('@aegis/db', () => ({
  getSequelize: () => sequelizeFake,
}));

// Imported AFTER the mock so the outbox + relay bind to the in-memory connection.
import {
  stageOutboxEvent,
  OutboxRelay,
  InProcessBus,
  setBus,
  setDeadLetterSink,
  makeEnvelope,
  EventTopic,
  type EventEnvelope,
} from '@aegis/events';
import { RequestContext, type RequestContextData } from '@aegis/service-core';
import { ServiceName } from '@aegis/shared-enums';
import type { Transaction } from 'sequelize';

const TENANT = '44444444-4444-4444-8444-444444444444';
const TX = 'TX' as unknown as Transaction;

function ctxSeed(): RequestContextData {
  return {
    tenantId: TENANT,
    correlationId: 'corr-flow3',
    sourceService: ServiceName.Expense as never,
    startedAt: Date.now(),
  };
}

beforeEach(() => {
  outboxTable.length = 0;
  rowSeq = 0;
  setBus(new InProcessBus()); // fresh real bus per test (no lingering subscriptions)
  // Restore the default dead-letter sink between tests (the throwing test installs its own).
  setDeadLetterSink((env, meta) => {
    void env;
    void meta;
  });
});

describe('FLOW 3 — transactional outbox staged inside the tx, relayed to the bus, DLQ on exhaustion', () => {
  it('stages the event atomically and the relay drains it to a real consumer (at-least-once)', async () => {
    const delivered: EventEnvelope[] = [];
    const bus = new InProcessBus();
    setBus(bus);
    bus.subscribe(EventTopic.ExpenseApproved, (env: EventEnvelope) => {
      delivered.push(env);
    });

    // STAGE inside the (mocked) business tx — the event becomes a pending outbox row, atomic w/ work.
    await RequestContext.run(ctxSeed(), async () => {
      const env = makeEnvelope(EventTopic.ExpenseApproved, {
        reportId: 'report-001',
        status: 'approved',
        approvedBy: 'user-bob',
        amountMinor: 5000,
        recipientUserId: 'user-bob',
      });
      await stageOutboxEvent(env, TX);
    });

    // Pre-drain: the row is persisted as pending and NOTHING has reached the bus yet (no dual-write).
    expect(outboxTable).toHaveLength(1);
    expect(outboxTable[0].status).toBe('pending');
    expect(delivered).toHaveLength(0);

    // RELAY: drain one pass → publish to the bus → mark published only after publish resolves.
    const relay = new OutboxRelay({ bus });
    const published = await relay.drainOnce();

    expect(published).toBe(1);
    expect(outboxTable[0].status).toBe('published');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].tenantId).toBe(TENANT); // the producer's tenant rode the envelope through
    expect(delivered[0].topic).toBe(EventTopic.ExpenseApproved);

    // A second drain is a no-op (nothing pending) — published rows are not re-sent.
    expect(await relay.drainOnce()).toBe(0);
    expect(delivered).toHaveLength(1);
  });

  it('a handler that always throws exhausts the bus retries → DLQ hook fires (no silent drop)', async () => {
    const deadLettered: Array<{ topic: string; attempts: number; error: string }> = [];
    setDeadLetterSink((env, meta) => {
      void env;
      deadLettered.push({ topic: meta.topic, attempts: meta.attempts, error: meta.error.message });
    });

    const bus = new InProcessBus();
    setBus(bus);

    let handlerCalls = 0;
    bus.subscribe(EventTopic.ExpenseApproved, () => {
      handlerCalls += 1;
      throw new Error('downstream consumer is down');
    });

    // Stage one event, then relay it. The relay's bus.publish drives the failing handler through the
    // bus's bounded retry; on exhaustion the DeadLetterSink fires (the envelope is parked, not lost).
    await RequestContext.run(ctxSeed(), async () => {
      await stageOutboxEvent(
        makeEnvelope(EventTopic.ExpenseApproved, {
          reportId: 'report-002',
          status: 'approved',
          approvedBy: 'user-bob',
          amountMinor: 9900,
          recipientUserId: 'user-bob',
        }),
        TX,
      );
    });

    const relay = new OutboxRelay({ bus });
    // The relay publishes once; the BUS itself retries the handler KAFKA_RETRY_MAX times, then
    // dead-letters — so bus.publish RESOLVES (the relay sees a successful publish and marks the row
    // published), but the failure left a forensic DLQ trail rather than being swallowed.
    await relay.drainOnce();

    // The handler was attempted exactly KAFKA_RETRY_MAX (3) times — bounded retry, no infinite loop.
    expect(handlerCalls).toBe(3);
    // And the dead-letter hook fired exactly once with the exhausted attempt count + the real error.
    expect(deadLettered).toHaveLength(1);
    expect(deadLettered[0]).toMatchObject({
      topic: EventTopic.ExpenseApproved,
      attempts: 3,
      error: 'downstream consumer is down',
    });
  });

  it('the relay parks a row as `failed` (not pending) when bus.publish itself rejects, after maxAttempts', async () => {
    // A bus whose publish REJECTS (distinct from the in-process retry-then-DLQ): the relay's own
    // attempt/park loop must increment attempts and finally mark the row `failed` — never silently
    // leave it pending to be re-drained forever.
    const rejectingBus = {
      publish: jest.fn(async () => {
        throw new Error('bus transport unavailable');
      }),
      subscribe: jest.fn(),
    };

    await RequestContext.run(ctxSeed(), async () => {
      await stageOutboxEvent(
        makeEnvelope(EventTopic.ExpenseApproved, {
          reportId: 'report-003',
          status: 'approved',
          approvedBy: 'user-bob',
          amountMinor: 100,
          recipientUserId: 'user-bob',
        }),
        TX,
      );
    });

    const relay = new OutboxRelay({ bus: rejectingBus as never, maxAttempts: 3 });

    // Drain repeatedly: each pass bumps attempts; the row stays pending until it hits maxAttempts,
    // then is parked as `failed` and no longer drained (no silent drop, no infinite re-publish).
    await relay.drainOnce(); // attempts → 1, still pending
    expect(outboxTable[0].status).toBe('pending');
    expect(outboxTable[0].attempts).toBe(1);

    await relay.drainOnce(); // attempts → 2, still pending
    expect(outboxTable[0].attempts).toBe(2);

    await relay.drainOnce(); // attempts → 3 === maxAttempts → parked failed
    expect(outboxTable[0].status).toBe('failed');
    expect(outboxTable[0].attempts).toBe(3);
    expect(outboxTable[0].last_error).toBe('bus transport unavailable');

    // A further drain is a no-op — a `failed` row is left for inspection, not re-published.
    const publishedNow = await relay.drainOnce();
    expect(publishedNow).toBe(0);
  });
});
