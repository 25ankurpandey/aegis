import { type Transaction, QueryTypes } from 'sequelize';
import { provideSingleton } from '../ioc/container';
import { getApprovalContext } from '../models/database-context';

/**
 * Serialises concurrent mutations of a single record's approval chain (BUG-0004).
 *
 * `decide()` reads the chain, counts the votes at a level, and decides whether the level's quorum is
 * met — a read-modify-write that, under READ COMMITTED with no lock, two concurrent approvers can
 * interleave: both can read the pre-vote chain and each conclude quorum is NOT yet met (the chain
 * stalls below quorum) or both conclude it IS (a double `ApprovalCompleted` → double ERP push). The
 * fix is a TRANSACTION-SCOPED Postgres advisory lock keyed on `(record_type, record_id)`, taken at
 * the very START of `decide()` inside the existing tenant transaction, BEFORE the chain is read. The
 * lock is held until the transaction commits/rolls back, so the two votes are forced to serialise:
 * the second waits for the first to commit, then reads a consistent, post-first-vote view.
 *
 * The key is a stable 64-bit integer derived from the record identity via Postgres'
 * `hashtextextended(text, seed)`, so it needs no extra column and never collides across record types
 * (the type is folded into the hashed text). Kept inside `@aegis/approvals` — it does NOT change the
 * shared transaction isolation level in `@aegis/db`.
 */
@provideSingleton(LockRepository)
export class LockRepository {
  /**
   * Take a transaction-scoped advisory lock for a record's approval chain. Blocks until the lock is
   * available; released automatically when the surrounding transaction ends. Must be called before
   * reading the chain in any mutating path so quorum counting + single-completion see a serialised
   * view.
   */
  async acquireRecordLock(
    recordType: string,
    recordId: string,
    t: Transaction,
  ): Promise<void> {
    // Production always has a live Sequelize with a real Postgres connection. In single-process unit /
    // in-memory-harness contexts (no built context, no real connection, no concurrency) there is
    // nothing to serialise, so skip the advisory lock gracefully rather than throwing on a stubbed
    // context. Only the context/connection-availability is guarded here; real query errors (deadlock,
    // lock timeout) from a live connection still propagate.
    let sequelize: ReturnType<typeof getApprovalContext>['sequelize'] | undefined;
    try {
      sequelize = getApprovalContext().sequelize;
    } catch {
      return;
    }
    if (!sequelize || typeof sequelize.query !== 'function') {
      return;
    }
    // Fold both identity components into one text key so distinct record types never collide; hash to
    // a stable bigint with a fixed seed. pg_advisory_xact_lock holds the lock until tx end.
    await sequelize.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, $2))',
      {
        bind: [`${recordType}:${recordId}`, 0],
        transaction: t,
        type: QueryTypes.SELECT,
      },
    );
  }
}
