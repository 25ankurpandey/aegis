import type { Transaction } from 'sequelize';
import { ApprovalShape } from '@aegis/shared-types';
import { ApproverGroupMemberType } from '@aegis/shared-enums';
import { provideSingleton } from '../ioc/container';
import { getApprovalContext } from '../models/database-context';

/**
 * Data access for `approver_groups` + `approver_group_members` (the named groups a level can route
 * to, and their polymorphic members). The approver resolver uses {@link expandUserMembers} to turn a
 * group into candidate user ids. Tenant-scoped via the ambient RLS transaction.
 */
@provideSingleton(ApproverGroupRepository)
export class ApproverGroupRepository {
  /** Create a named group. */
  async createGroup(
    data: Partial<ApprovalShape.ApproverGroupRow>,
    t: Transaction,
  ): Promise<ApprovalShape.ApproverGroupRow> {
    const { Group } = getApprovalContext();
    const row = await Group.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as ApprovalShape.ApproverGroupRow;
  }

  /** Look up a group by id. */
  async findGroupById(id: string, t: Transaction): Promise<ApprovalShape.ApproverGroupRow | null> {
    const { Group } = getApprovalContext();
    const row = await Group.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as ApprovalShape.ApproverGroupRow) : null;
  }

  /** Add a polymorphic member (user | role) to a group. */
  async addMember(
    data: { group_id: string; member_type: ApproverGroupMemberType; member_id: string },
    t: Transaction,
  ): Promise<ApprovalShape.ApproverGroupMemberRow> {
    const { GroupMember } = getApprovalContext();
    const row = await GroupMember.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as ApprovalShape.ApproverGroupMemberRow;
  }

  /** List every member of a group. */
  async listMembers(
    groupId: string,
    t: Transaction,
  ): Promise<ApprovalShape.ApproverGroupMemberRow[]> {
    const { GroupMember } = getApprovalContext();
    const rows = await GroupMember.findAll({ where: { group_id: groupId }, transaction: t });
    return rows.map((r) => r.get({ plain: true }) as ApprovalShape.ApproverGroupMemberRow);
  }

  /**
   * Expand a group to its `user`-kind members' ids — the candidate approvers a group-typed level
   * resolves to. (Role-kind members are an extension seam later agents expand against the tenant's
   * role→user assignments.)
   */
  async expandUserMembers(groupId: string, t: Transaction): Promise<string[]> {
    const members = await this.listMembers(groupId, t);
    return members
      .filter((m) => m.member_type === ApproverGroupMemberType.User)
      .map((m) => m.member_id);
  }
}
