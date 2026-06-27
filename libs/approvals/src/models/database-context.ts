import type { ModelStatic, Model, Sequelize } from 'sequelize';
import { getSequelize, createModelRegistry } from '@aegis/db';
import { defineApprovalPolicy } from './approval-policy.model';
import { defineApprovalHierarchy } from './approval-hierarchy.model';
import { defineApproverGroup } from './approver-group.model';
import { defineApproverGroupMember } from './approver-group-member.model';
import { defineRecordApprover } from './record-approver.model';
import { defineApprovalVote } from './approval-vote.model';

type M = ModelStatic<Model>;

/** The set of approval-engine models, registered on the shared connection (the lib's DatabaseContext). */
export interface ApprovalContext {
  Policy: M;
  Hierarchy: M;
  Group: M;
  GroupMember: M;
  RecordApprover: M;
  Vote: M;
  sequelize: Sequelize;
}

let ctx: ApprovalContext | null = null;

/**
 * Defines every approval-engine model on the shared `getSequelize()` connection (once), through the
 * single registry path (so the shared base-model options apply uniformly), and returns the assembled
 * context. Memoised — repeated calls return the same context (SPEC §11.1 — one `*.model.ts` per
 * table + a `database-context.ts` that imports + registers them).
 */
export function getApprovalContext(): ApprovalContext {
  if (ctx) return ctx;
  const s = getSequelize();
  const registry = createModelRegistry(s);

  const Policy = defineApprovalPolicy(registry);
  const Hierarchy = defineApprovalHierarchy(registry);
  const Group = defineApproverGroup(registry);
  const GroupMember = defineApproverGroupMember(registry);
  const RecordApprover = defineRecordApprover(registry);
  const Vote = defineApprovalVote(registry);

  GroupMember.belongsTo(Group, { foreignKey: 'group_id', as: 'group' });
  Group.hasMany(GroupMember, { foreignKey: 'group_id', as: 'members' });

  ctx = { Policy, Hierarchy, Group, GroupMember, RecordApprover, Vote, sequelize: s };
  return ctx;
}

/** Reset the memoised context — test-only seam so a fresh mocked connection can be wired per spec. */
export function resetApprovalContext(): void {
  ctx = null;
}
