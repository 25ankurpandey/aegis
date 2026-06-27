import type { Transaction } from 'sequelize';
import { ApprovalShape } from '@aegis/shared-types';
import { RecordApproverStatus } from '@aegis/shared-enums';
import { provideSingleton } from '../ioc/container';
import { getApprovalContext } from '../models/database-context';

/**
 * Data access for `record_approvers` — the resolved approver chain for one record instance. The
 * engine writes the chain on `requestApproval` and advances slot statuses on `decide`. Tenant-scoped
 * via the ambient RLS transaction; the unique `(record, level, approver)` index makes re-resolution
 * idempotent.
 */
@provideSingleton(RecordApproverRepository)
export class RecordApproverRepository {
  /** Persist one resolved slot of a record's chain (live by default). */
  async create(
    data: Partial<ApprovalShape.RecordApproverRow>,
    t: Transaction,
  ): Promise<ApprovalShape.RecordApproverRow> {
    const { RecordApprover } = getApprovalContext();
    const row = await RecordApprover.create(
      { is_active: true, ...data },
      { transaction: t },
    );
    return row.get({ plain: true }) as ApprovalShape.RecordApproverRow;
  }

  /**
   * The LIVE chain for a record (active slots only), ordered by `(level, sequence)`. The engine
   * operates on this — superseded slots (W3-06) are retired from the live chain but kept for history
   * (see {@link listHistoryForRecord}).
   */
  async listForRecord(
    recordType: string,
    recordId: string,
    t: Transaction,
  ): Promise<ApprovalShape.RecordApproverRow[]> {
    const { RecordApprover } = getApprovalContext();
    const rows = await RecordApprover.findAll({
      where: { record_type: recordType, record_id: recordId, is_active: true },
      order: [
        ['level', 'ASC'],
        ['sequence', 'ASC'],
      ],
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as ApprovalShape.RecordApproverRow);
  }

  /**
   * The FULL chain history for a record (active AND superseded slots), ordered by
   * `(level, sequence, created_at)` — the complete who-was-asked provenance for `getStatus` (W3-06).
   */
  async listHistoryForRecord(
    recordType: string,
    recordId: string,
    t: Transaction,
  ): Promise<ApprovalShape.RecordApproverRow[]> {
    const { RecordApprover } = getApprovalContext();
    const rows = await RecordApprover.findAll({
      where: { record_type: recordType, record_id: recordId },
      order: [
        ['level', 'ASC'],
        ['sequence', 'ASC'],
        ['created_at', 'ASC'],
      ],
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as ApprovalShape.RecordApproverRow);
  }

  /**
   * The LIVE, still-PENDING slots a given approver currently owns for a record type, newest first.
   * Backs a "my pending approvals" inbox per record type (the chain advances level-by-level, so a
   * slot only surfaces here once its level is the active one and the approver has not yet voted).
   * Tenant-scoped via RLS; an optional `recordType` narrows to one approvable type.
   */
  async listPendingForApprover(
    approverId: string,
    recordType: string | undefined,
    t: Transaction,
  ): Promise<ApprovalShape.RecordApproverRow[]> {
    const { RecordApprover } = getApprovalContext();
    const where: Record<string, unknown> = {
      approver_id: approverId,
      status: RecordApproverStatus.Pending,
      is_active: true,
    };
    if (recordType !== undefined) where['record_type'] = recordType;
    const rows = await RecordApprover.findAll({
      where,
      order: [['created_at', 'DESC']],
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as ApprovalShape.RecordApproverRow);
  }

  /** Whether any LIVE slot exists for a record (i.e. the chain has already been materialised). */
  async existsForRecord(
    recordType: string,
    recordId: string,
    t: Transaction,
  ): Promise<boolean> {
    const { RecordApprover } = getApprovalContext();
    const count = await RecordApprover.count({
      where: { record_type: recordType, record_id: recordId, is_active: true },
      transaction: t,
    });
    return count > 0;
  }

  /** Update the status of one slot (matched by id). */
  async setStatus(
    id: string,
    status: RecordApproverStatus,
    t: Transaction,
  ): Promise<void> {
    const { RecordApprover } = getApprovalContext();
    await RecordApprover.update({ status }, { where: { id }, transaction: t });
  }

  /**
   * Mark every still-pending LIVE slot of a record as `skipped` (used when a rejection short-circuits
   * the chain, or a sequential level was satisfied by another approver). Returns the number updated.
   */
  async skipRemaining(
    recordType: string,
    recordId: string,
    t: Transaction,
  ): Promise<number> {
    const { RecordApprover } = getApprovalContext();
    const [count] = await RecordApprover.update(
      { status: RecordApproverStatus.Skipped },
      {
        where: {
          record_type: recordType,
          record_id: recordId,
          status: RecordApproverStatus.Pending,
          is_active: true,
        },
        transaction: t,
      },
    );
    return count;
  }

  /**
   * Mark every still-pending LIVE slot AT a given level as `skipped` — used when a level's quorum is
   * met by other approvers and the chain advances, so the level's remaining members can no longer
   * act. Returns the number updated.
   */
  async skipRemainingAtLevel(
    recordType: string,
    recordId: string,
    level: number,
    t: Transaction,
  ): Promise<number> {
    const { RecordApprover } = getApprovalContext();
    const [count] = await RecordApprover.update(
      { status: RecordApproverStatus.Skipped },
      {
        where: {
          record_type: recordType,
          record_id: recordId,
          level,
          status: RecordApproverStatus.Pending,
          is_active: true,
        },
        transaction: t,
      },
    );
    return count;
  }

  /**
   * Retire one slot from the live chain (W3-06): flip `is_active` false, stamp its status
   * `superseded`, and point `superseded_by_id` at the slot that replaced it (when known). The row is
   * preserved for the who-was-asked history; only the LIVE chain (`is_active`) stops seeing it.
   */
  async supersede(
    id: string,
    supersededById: string | null,
    t: Transaction,
  ): Promise<void> {
    const { RecordApprover } = getApprovalContext();
    await RecordApprover.update(
      {
        status: RecordApproverStatus.Superseded,
        is_active: false,
        superseded_by_id: supersededById,
      },
      { where: { id }, transaction: t },
    );
  }
}
