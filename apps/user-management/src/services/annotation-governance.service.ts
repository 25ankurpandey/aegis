import { inject } from 'inversify';
import { ErrUtils, FeatureFlags, RequestContext } from '@aegis/service-core';
import { AuditAction, AuditOutcome, ApprovalRecordType } from '@aegis/shared-enums';
import { UserManagementShape } from '@aegis/shared-types';
import {
  RecordAnnotationFeatureFlag,
  attachRecordTags,
  detachRecordTags,
  withTenantTransaction,
} from '@aegis/db';
import { AuditLogger } from '@aegis/audit';
import { EventTopic, makeEnvelope, stageOutboxEvent } from '@aegis/events';
import { provideSingleton } from '../ioc/container';
import { TeamRepository } from '../repositories/team.repository';
import { TeamMemberRepository } from '../repositories/team-member.repository';
import { TagRepository } from '../repositories/tag.repository';
import { TeamTagRepository } from '../repositories/team-tag.repository';
import { RecordTagRepository } from '../repositories/record-tag.repository';

@provideSingleton(AnnotationGovernanceService)
export class AnnotationGovernanceService {
  constructor(
    @inject(TeamRepository) private readonly teams: TeamRepository,
    @inject(TeamMemberRepository) private readonly teamMembers: TeamMemberRepository,
    @inject(TagRepository) private readonly tags: TagRepository,
    @inject(TeamTagRepository) private readonly teamTags: TeamTagRepository,
    @inject(RecordTagRepository) private readonly recordTags: RecordTagRepository,
  ) {}

  async listTeams(): Promise<UserManagementShape.TeamRow[]> {
    await this.assertEnabled();
    return withTenantTransaction((t) => this.teams.list(t));
  }

  async createTeam(input: {
    name: string;
    description?: string;
  }): Promise<UserManagementShape.TeamRow> {
    await this.assertEnabled();
    const tenantId = RequestContext.tenantId();
    const userId = RequestContext.userId() ?? null;
    return withTenantTransaction(async (t) => {
      const row = await this.teams.create(
        {
          tenant_id: tenantId,
          name: input.name,
          description: input.description,
          created_by: userId,
          updated_by: userId,
        },
        t,
      );
      await AuditLogger.record(
        {
          action: AuditAction.RecordCreated,
          outcome: AuditOutcome.Success,
          resourceType: 'team',
          resourceId: row.id,
          details: { name: row.name },
        },
        t,
      );
      return row;
    });
  }

  async updateTeam(
    id: string,
    input: UserManagementShape.UpdateTeamInput,
  ): Promise<UserManagementShape.TeamRow> {
    await this.assertEnabled();
    const userId = RequestContext.userId() ?? null;
    return withTenantTransaction(async (t) => {
      const row = await this.teams.update(id, { ...input, updated_by: userId }, t);
      if (!row) throw ErrUtils.notFound('Team not found');
      await AuditLogger.record(
        {
          action: AuditAction.RecordUpdated,
          outcome: AuditOutcome.Success,
          resourceType: 'team',
          resourceId: id,
          details: input,
        },
        t,
      );
      return row;
    });
  }

  async deleteTeam(id: string): Promise<{ deleted: true }> {
    await this.assertEnabled();
    return withTenantTransaction(async (t) => {
      const deleted = await this.teams.delete(id, t);
      if (!deleted) throw ErrUtils.notFound('Team not found');
      await AuditLogger.record(
        {
          action: AuditAction.RecordDeleted,
          outcome: AuditOutcome.Success,
          resourceType: 'team',
          resourceId: id,
        },
        t,
      );
      return { deleted: true };
    });
  }

  async listTeamMembers(teamId: string): Promise<UserManagementShape.TeamMemberRow[]> {
    await this.assertEnabled();
    return withTenantTransaction((t) => this.teamMembers.listByTeam(teamId, t));
  }

  async addTeamMember(
    teamId: string,
    input: { userId: string; role?: string },
  ): Promise<UserManagementShape.TeamMemberRow> {
    await this.assertEnabled();
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      const row = await this.teamMembers.add(
        { tenant_id: tenantId, team_id: teamId, user_id: input.userId, role: input.role },
        t,
      );
      await AuditLogger.record(
        {
          action: AuditAction.RecordCreated,
          outcome: AuditOutcome.Success,
          resourceType: 'team_member',
          resourceId: row.id,
          details: { teamId, userId: input.userId, role: input.role },
        },
        t,
      );
      return row;
    });
  }

  async removeTeamMember(teamId: string, userId: string): Promise<{ deleted: true }> {
    await this.assertEnabled();
    return withTenantTransaction(async (t) => {
      await this.teamMembers.remove(teamId, userId, t);
      await AuditLogger.record(
        {
          action: AuditAction.RecordDeleted,
          outcome: AuditOutcome.Success,
          resourceType: 'team_member',
          resourceId: `${teamId}:${userId}`,
          details: { teamId, userId },
        },
        t,
      );
      return { deleted: true };
    });
  }

  async listTags(): Promise<UserManagementShape.TagRow[]> {
    await this.assertEnabled();
    return withTenantTransaction((t) => this.tags.list(t));
  }

  async createTag(input: { name: string; color?: string }): Promise<UserManagementShape.TagRow> {
    await this.assertEnabled();
    const tenantId = RequestContext.tenantId();
    const userId = RequestContext.userId() ?? null;
    return withTenantTransaction(async (t) => {
      const row = await this.tags.create(
        {
          tenant_id: tenantId,
          name: input.name,
          color: input.color,
          created_by: userId,
          updated_by: userId,
        },
        t,
      );
      await AuditLogger.record(
        {
          action: AuditAction.RecordCreated,
          outcome: AuditOutcome.Success,
          resourceType: 'tag',
          resourceId: row.id,
          details: { name: row.name },
        },
        t,
      );
      return row;
    });
  }

  async updateTag(
    id: string,
    input: UserManagementShape.UpdateTagInput,
  ): Promise<UserManagementShape.TagRow> {
    await this.assertEnabled();
    const userId = RequestContext.userId() ?? null;
    return withTenantTransaction(async (t) => {
      const row = await this.tags.update(id, { ...input, updated_by: userId }, t);
      if (!row) throw ErrUtils.notFound('Tag not found');
      await AuditLogger.record(
        {
          action: AuditAction.RecordUpdated,
          outcome: AuditOutcome.Success,
          resourceType: 'tag',
          resourceId: id,
          details: input,
        },
        t,
      );
      return row;
    });
  }

  async deleteTag(id: string): Promise<{ deleted: true }> {
    await this.assertEnabled();
    return withTenantTransaction(async (t) => {
      const deleted = await this.tags.delete(id, t);
      if (!deleted) throw ErrUtils.notFound('Tag not found');
      await AuditLogger.record(
        {
          action: AuditAction.RecordDeleted,
          outcome: AuditOutcome.Success,
          resourceType: 'tag',
          resourceId: id,
        },
        t,
      );
      return { deleted: true };
    });
  }

  async listTeamTags(teamId: string): Promise<UserManagementShape.TeamTagRow[]> {
    await this.assertEnabled();
    return withTenantTransaction((t) => this.teamTags.listByTeam(teamId, t));
  }

  async setTeamTags(teamId: string, tagIds: string[]): Promise<{ updated: true }> {
    await this.assertEnabled();
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      await this.teamTags.setTags(tenantId, teamId, tagIds, t);
      await AuditLogger.record(
        {
          action: AuditAction.RecordUpdated,
          outcome: AuditOutcome.Success,
          resourceType: 'team',
          resourceId: teamId,
          details: { tagIds },
        },
        t,
      );
      return { updated: true };
    });
  }

  async listRecordTags(
    recordType: ApprovalRecordType,
    recordId: string,
  ): Promise<UserManagementShape.RecordTagRow[]> {
    await this.assertEnabled();
    return withTenantTransaction((t) => this.recordTags.listForRecord(recordType, recordId, t));
  }

  async attachRecordTag(
    recordType: ApprovalRecordType,
    recordId: string,
    tagId: string,
  ): Promise<{ updated: true }> {
    await this.assertEnabled();
    const tenantId = RequestContext.tenantId();
    const actorId = RequestContext.userId() ?? null;
    return withTenantTransaction(async (t) => {
      const result = await attachRecordTags({
        tenantId,
        recordType,
        recordId,
        tags: [tagId],
        source: 'manual',
        actorId,
        transaction: t,
        createMissingCatalogTags: false,
      });
      if (result.added.length > 0) {
        await stageOutboxEvent(
          makeEnvelope(EventTopic.RecordUpdated, {
            recordType,
            recordId,
            tags: result.added,
            ruleId: 'manual:record.tag.add',
          }),
          t,
        );
      }
      await AuditLogger.record(
        {
          action: AuditAction.RecordUpdated,
          outcome: AuditOutcome.Success,
          resourceType: recordType,
          resourceId: recordId,
          details: { tagId, tagsAdded: result.added },
        },
        t,
      );
      return { updated: true };
    });
  }

  async detachRecordTag(
    recordType: ApprovalRecordType,
    recordId: string,
    tagId: string,
  ): Promise<{ updated: true }> {
    await this.assertEnabled();
    const tenantId = RequestContext.tenantId();
    const actorId = RequestContext.userId() ?? null;
    return withTenantTransaction(async (t) => {
      const result = await detachRecordTags({
        tenantId,
        recordType,
        recordId,
        tags: [tagId],
        source: 'manual',
        actorId,
        transaction: t,
      });
      if (result.removed.length > 0) {
        await stageOutboxEvent(
          makeEnvelope(EventTopic.RecordUpdated, {
            recordType,
            recordId,
            removeTags: result.removed,
            ruleId: 'manual:record.tag.remove',
          }),
          t,
        );
      }
      await AuditLogger.record(
        {
          action: AuditAction.RecordUpdated,
          outcome: AuditOutcome.Success,
          resourceType: recordType,
          resourceId: recordId,
          details: { tagId, tagsRemoved: result.removed },
        },
        t,
      );
      return { updated: true };
    });
  }

  async assignRecord(
    recordType: ApprovalRecordType,
    recordId: string,
    input: UserManagementShape.AssignRecordInput,
  ): Promise<{ updated: true }> {
    await this.assertEnabled();
    return withTenantTransaction(async (t) => {
      await stageOutboxEvent(
        makeEnvelope(EventTopic.RecordUpdated, {
          recordType,
          recordId,
          assigneeId: input.assigneeId,
          ruleId: 'manual:record.assign',
        }),
        t,
      );
      await AuditLogger.record(
        {
          action: AuditAction.RecordUpdated,
          outcome: AuditOutcome.Success,
          resourceType: recordType,
          resourceId: recordId,
          details: { assigneeId: input.assigneeId },
        },
        t,
      );
      return { updated: true };
    });
  }

  private async assertEnabled(): Promise<void> {
    if (!(await FeatureFlags.isEnabled(RecordAnnotationFeatureFlag))) {
      throw ErrUtils.forbidden(`Feature flag '${RecordAnnotationFeatureFlag}' is disabled`);
    }
  }
}
