import { QueryTypes, type Transaction } from 'sequelize';
import { Logger } from '@aegis/service-core';
import { getSequelize } from '@aegis/db';
import { RlsConstants } from '@aegis/shared-constants';
import { TableName } from '@aegis/shared-enums';
import { getBus, type EventBus } from './bus';
import type { EventEnvelope, EventTopic } from './topics';

/**
 * Transactional outbox (W2-06). Instead of publishing a domain event AFTER the business transaction
 * commits (a dual-write: a crash between commit and publish loses the event), the event is STAGED as
 * a row in `event_outbox` INSIDE the same `withTenantTransaction` as the business write. The event is
 * therefore persisted ATOMICALLY with the write — it commits with the work or rolls back with it.
 *
 * A separate RELAY (see {@link OutboxRelay}) later drains pending rows to the bus at-least-once and
 * marks them published, closing the dual-write gap. The relay can also run in-process for single-image
 * local dev so the event still reaches its in-process consumers.
 */

/** Persisted outbox lifecycle. `failed` rows are left for inspection after retry exhaustion. */
export type OutboxStatus = 'pending' | 'published' | 'failed';

/** A row drained by the relay. */
export interface OutboxRow {
  id: string;
  tenant_id: string;
  topic: EventTopic;
  payload: unknown;
  envelope: EventEnvelope;
  status: OutboxStatus;
  attempts: number;
}

/**
 * Stage one event into the outbox INSIDE the caller's transaction. Must be called with the SAME
 * `Transaction` the business write uses (from `withTenantTransaction`), so the insert is atomic with
 * the write and subject to the same RLS tenant context. The full envelope is captured so the relay
 * republishes exactly what the producer authored (correlation id + source service intact).
 */
export async function stageOutboxEvent(env: EventEnvelope, t: Transaction): Promise<void> {
  await getSequelize().query(
    `INSERT INTO "${TableName.EventOutbox}"
       (id, tenant_id, topic, payload, envelope, status, attempts, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'pending', 0, now())`,
    {
      bind: [
        env.id,
        env.tenantId,
        env.topic,
        JSON.stringify(env.payload ?? {}),
        JSON.stringify(env),
      ],
      type: QueryTypes.INSERT,
      transaction: t,
    },
  );
}

/**
 * Transactional-outbox buffer: events produced during a unit of work are collected and only written
 * to the outbox table when `flush(t)` is called inside the committing transaction, so a rolled-back
 * transaction never stages an event. Use `withOutbox` to scope a buffer; call `outbox.flush(t)` as the
 * LAST step inside the same `withTenantTransaction` body.
 */
export class OutboxBuffer {
  private events: EventEnvelope[] = [];

  collect(env: EventEnvelope): void {
    this.events.push(env);
  }

  pending(): ReadonlyArray<EventEnvelope> {
    return this.events;
  }

  /** Stage all collected events into the outbox table inside the given transaction. */
  async flush(t: Transaction): Promise<void> {
    const toStage = this.events;
    this.events = [];
    for (const env of toStage) {
      await stageOutboxEvent(env, t);
    }
  }
}

/**
 * Run `fn` with a fresh outbox buffer; the buffer's events are staged into the outbox table by
 * `fn` itself via `outbox.flush(t)` inside the transaction. (Kept for symmetry with the prior API;
 * most producers call `stageOutboxEvent` directly.)
 */
export async function withOutbox<T>(fn: (outbox: OutboxBuffer) => Promise<T>): Promise<T> {
  const outbox = new OutboxBuffer();
  return fn(outbox);
}

/** Tuning for the relay poll loop. */
export interface OutboxRelayOptions {
  /** Rows drained per poll (per tenant batch). Default OUTBOX_RELAY_BATCH / 100. */
  batchSize?: number;
  /** Poll interval in ms when the last poll drained nothing. Default OUTBOX_RELAY_INTERVAL_MS / 1000. */
  intervalMs?: number;
  /** Max publish attempts before a row is parked as `failed`. Default OUTBOX_RELAY_MAX_ATTEMPTS / 5. */
  maxAttempts?: number;
  /** Bus to publish to. Default `getBus()`. */
  bus?: EventBus;
}

/**
 * Drains the `event_outbox` to the bus at-least-once. One pass:
 *   1. opens a transaction, sets the relay-bypass RLS marker (SET LOCAL app.outbox_relay='on') so it
 *      can see EVERY tenant's pending rows,
 *   2. selects pending rows oldest-first with FOR UPDATE SKIP LOCKED (so concurrent relay instances
 *      never double-publish the same row),
 *   3. publishes each to the bus and marks it published (or increments attempts / parks as `failed`
 *      after `maxAttempts`),
 *   4. commits — releasing the row locks.
 *
 * At-least-once: a row is only marked `published` AFTER `bus.publish` resolves, so a crash mid-pass
 * re-drains it next time (consumers are already idempotent via the envelope id). Wire `start()` into a
 * worker / a dedicated PROCESS_TYPE=relay process; call `drainOnce()` directly in single-process dev.
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly bus: EventBus;
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(opts: OutboxRelayOptions = {}) {
    this.batchSize = opts.batchSize ?? intFromEnv('OUTBOX_RELAY_BATCH', 100);
    this.intervalMs = opts.intervalMs ?? intFromEnv('OUTBOX_RELAY_INTERVAL_MS', 1000);
    this.maxAttempts = opts.maxAttempts ?? intFromEnv('OUTBOX_RELAY_MAX_ATTEMPTS', 5);
    this.bus = opts.bus ?? getBus();
  }

  /** Drain one batch. Returns the number of rows successfully published this pass. */
  async drainOnce(): Promise<number> {
    const sequelize = getSequelize();
    return sequelize.transaction(async (t) => {
      // Relay-bypass marker (transaction-local): admit pending rows for ALL tenants under RLS.
      await sequelize.query(`SELECT set_config($1, 'on', true)`, {
        bind: [RlsConstants.OutboxRelayVar],
        type: QueryTypes.SELECT,
        transaction: t,
      });

      const rows = (await sequelize.query(
        `SELECT id, tenant_id, topic, payload, envelope, status, attempts
           FROM "${TableName.EventOutbox}"
          WHERE status = 'pending'
          ORDER BY created_at ASC
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED`,
        { type: QueryTypes.SELECT, transaction: t },
      )) as OutboxRow[];

      let published = 0;
      for (const row of rows) {
        try {
          await this.bus.publish(row.envelope);
          await sequelize.query(
            `UPDATE "${TableName.EventOutbox}"
                SET status = 'published', published_at = now(), last_error = NULL
              WHERE id = $1`,
            { bind: [row.id], type: QueryTypes.UPDATE, transaction: t },
          );
          published += 1;
        } catch (err) {
          const error = err as Error;
          const attempts = Number(row.attempts) + 1;
          const parked = attempts >= this.maxAttempts;
          await sequelize.query(
            `UPDATE "${TableName.EventOutbox}"
                SET attempts = $2, status = $3, last_error = $4
              WHERE id = $1`,
            {
              bind: [row.id, attempts, parked ? 'failed' : 'pending', error.message],
              type: QueryTypes.UPDATE,
              transaction: t,
            },
          );
          Logger.error(error, 'OUTBOX_RELAY', row.topic, {
            outboxId: row.id,
            attempts,
            parked,
          });
        }
      }
      return published;
    });
  }

  /**
   * Start the background poll loop (idempotent). ADAPTIVE cadence (BUG-0003): each pass captures how
   * many rows `drainOnce()` published; when that equals `batchSize` a backlog likely remains, so we
   * re-drain PROMPTLY (a 0ms timer ≈ setImmediate) instead of idling a full `intervalMs` — clearing
   * the backlog at full speed. When a pass drains FEWER than `batchSize` (caught up), we fall back to
   * polling every `intervalMs`. At-least-once + mark-published-after-publish are unchanged (this only
   * affects WHEN the next pass runs, not the drain semantics).
   */
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = async (): Promise<void> => {
      if (this.running || this.stopped) return;
      this.running = true;
      let published = 0;
      try {
        published = await this.drainOnce();
      } catch (err) {
        Logger.error(err as Error, 'OUTBOX_RELAY', 'drain');
      } finally {
        this.running = false;
      }
      // Re-arm: a full batch implies more backlog -> drain again immediately; else idle one interval.
      const delay = published >= this.batchSize ? 0 : this.intervalMs;
      this.schedule(tick, delay);
    };
    this.schedule(tick, this.intervalMs);
    Logger.info('outbox relay started', { intervalMs: this.intervalMs, batchSize: this.batchSize });
  }

  /** (Re)arm the single poll timer after `delay` ms; no-op once stopped. unref'd so it never pins the process. */
  private schedule(tick: () => Promise<void>, delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void tick(), delay);
    // Don't keep the process alive solely for the relay timer.
    this.timer.unref?.();
  }

  /** Stop the poll loop (graceful shutdown). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}
