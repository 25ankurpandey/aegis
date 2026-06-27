import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import type { ApprovalRecordType } from '@aegis/shared-enums';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for the `record_tags` polymorphic join (Wave-6). Attaches catalog tags to a finance
 * record `(record_type, record_id)` with provenance. Every method takes the ambient RLS-scoped
 * `Transaction` opened by the service via `withTenantTransaction`.
 */
@provideSingleton(RecordTagRepository)
export class RecordTagRepository {
  /** All tags attached to one record. */
  async listForRecord(
    recordType: ApprovalRecordType,
    recordId: string,
    t: Transaction,
  ): Promise<UserManagementShape.RecordTagRow[]> {
    const { RecordTag } = getIdentityContext();
    const rows = await RecordTag.findAll({
      where: { record_type: recordType, record_id: recordId },
      transaction: t,
    });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.RecordTagRow);
  }

  /** Attach a tag to a record (idempotent on the (tenant, record_type, record_id, tag_id) unique key). */
  async attach(
    data: UserManagementShape.AttachRecordTagInput,
    t: Transaction,
  ): Promise<UserManagementShape.RecordTagRow> {
    const { RecordTag } = getIdentityContext();
    const row = await RecordTag.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.RecordTagRow;
  }

  /** Detach a tag from a record. */
  async detach(
    recordType: ApprovalRecordType,
    recordId: string,
    tagId: string,
    t: Transaction,
  ): Promise<number> {
    const { RecordTag } = getIdentityContext();
    return RecordTag.destroy({
      where: { record_type: recordType, record_id: recordId, tag_id: tagId },
      transaction: t,
    });
  }
}
