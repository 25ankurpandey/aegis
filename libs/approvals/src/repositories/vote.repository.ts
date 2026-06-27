import type { Transaction } from 'sequelize';
import { ApprovalShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getApprovalContext } from '../models/database-context';

/**
 * Data access for `approvals` — the immutable, append-only vote ledger. The engine appends one row
 * per recorded decision; it is never updated. Tenant-scoped via the ambient RLS transaction. The
 * DB's unique `(record, level, approver)` index plus {@link hasVoted} enforce the no-double-vote
 * invariant.
 */
@provideSingleton(VoteRepository)
export class VoteRepository {
  /** Append one immutable vote. */
  async append(
    data: Partial<ApprovalShape.ApprovalVoteRow>,
    t: Transaction,
  ): Promise<ApprovalShape.ApprovalVoteRow> {
    const { Vote } = getApprovalContext();
    const row = await Vote.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as ApprovalShape.ApprovalVoteRow;
  }

  /** Whether this approver has already voted at this level for the record (no-double-vote guard). */
  async hasVoted(
    recordType: string,
    recordId: string,
    level: number,
    approverId: string,
    t: Transaction,
  ): Promise<boolean> {
    const { Vote } = getApprovalContext();
    const count = await Vote.count({
      where: { record_type: recordType, record_id: recordId, level, approver_id: approverId },
      transaction: t,
    });
    return count > 0;
  }

  /** Every vote recorded for a record, oldest first. */
  async listForRecord(
    recordType: string,
    recordId: string,
    t: Transaction,
  ): Promise<ApprovalShape.ApprovalVoteRow[]> {
    const { Vote } = getApprovalContext();
    const rows = await Vote.findAll({
      where: { record_type: recordType, record_id: recordId },
      order: [['decided_at', 'ASC']],
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as ApprovalShape.ApprovalVoteRow);
  }
}
