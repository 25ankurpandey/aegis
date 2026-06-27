import { EventTopic, getBus, makeEnvelope } from '@aegis/events';
import { ConnectorEntity, ConnectorKind, RuleActionType } from '@aegis/shared-enums';
import { randomUUID } from 'node:crypto';
import type { ActionContext, ActionSpec, ActionStatus } from '../types';
import { registerAction } from './registry';

/**
 * Built-in action handlers. Each performs a SCOPED side effect — typically emitting a follow-on
 * event the owning service consumes (keeping every service the owner of its own data) — and returns
 * a typed ActionStatus. New actions are added by registering a function, never by editing the core.
 */

function recordRef(ctx: ActionContext): { recordType: string; recordId: string } {
  return {
    recordType: String(ctx.record['record_type'] ?? ''),
    recordId: String(ctx.record['id'] ?? ''),
  };
}

/**
 * auto_approve — request auto-approval (subject to gating in the owning service). This is a
 * WORKFLOW → owning-service COMMAND, emitted on `ApprovalCommand` (NOT the user-facing
 * `ApprovalRequested` the notification service consumes) so the two contracts never collide. Awaited
 * so a publish failure surfaces in the action verdict instead of becoming an unhandled rejection.
 */
async function autoApprove(ctx: ActionContext, action: ActionSpec): Promise<ActionStatus> {
  // Gating invariant (belt-and-suspenders): never auto-approve a disputed/blocked record.
  const status = ctx.record['status'];
  if (status === 'disputed' || status === 'blocked' || status === 'rejected') return 'skip';
  await getBus().publish(
    makeEnvelope(EventTopic.ApprovalCommand, {
      ...recordRef(ctx),
      autoApprove: true,
      ruleId: ctx.rule.id,
      reason: (action.config['reason'] as string | undefined) ?? 'workflow.auto_approve',
    }),
  );
  return 'success';
}

/** assign_approval_policy — bind a (stricter/looser) approval policy (workflow → service command). */
async function assignApprovalPolicy(ctx: ActionContext, action: ActionSpec): Promise<ActionStatus> {
  const policyId = action.config['policyId'];
  if (!policyId) return 'skip';
  await getBus().publish(
    makeEnvelope(EventTopic.ApprovalCommand, {
      ...recordRef(ctx),
      policyId: String(policyId),
      ruleId: ctx.rule.id,
    }),
  );
  return 'success';
}

/** assign_team — set the owning team (emits a record-updated follow-on). */
async function assignTeam(ctx: ActionContext, action: ActionSpec): Promise<ActionStatus> {
  const teamId = action.config['teamId'];
  if (!teamId) return 'skip';
  await getBus().publish(
    makeEnvelope(EventTopic.RecordUpdated, {
      ...recordRef(ctx),
      teamId,
      ruleId: ctx.rule.id,
    }),
  );
  return 'success';
}

/** assign_owner — set the owning/assignee user (emits a record-updated follow-on). */
async function assignOwner(ctx: ActionContext, action: ActionSpec): Promise<ActionStatus> {
  const assigneeId = action.config['assigneeId'] ?? action.config['userId'];
  if (!assigneeId) return 'skip';
  await getBus().publish(
    makeEnvelope(EventTopic.RecordUpdated, {
      ...recordRef(ctx),
      assigneeId,
      ruleId: ctx.rule.id,
    }),
  );
  return 'success';
}

/** add_tag — attach classification tags (emits a record-updated follow-on). */
async function addTag(ctx: ActionContext, action: ActionSpec): Promise<ActionStatus> {
  const tags = action.config['tags'];
  if (!Array.isArray(tags) || tags.length === 0) return 'no_update';
  await getBus().publish(
    makeEnvelope(EventTopic.RecordUpdated, {
      ...recordRef(ctx),
      tags,
      ruleId: ctx.rule.id,
    }),
  );
  return 'success';
}

/** notify — ask the notification service to ping a recipient (never writes its tables). */
async function notify(ctx: ActionContext, action: ActionSpec): Promise<ActionStatus> {
  const recipientUserId =
    (action.config['recipientUserId'] as string | undefined) ??
    (ctx.record['owner_user_id'] as string | undefined);
  if (!recipientUserId) return 'skip';
  await getBus().publish(
    makeEnvelope(EventTopic.NotificationRequested, {
      recipientUserId,
      template: (action.config['template'] as string | undefined) ?? 'rule.notice',
      context: { ...recordRef(ctx), ruleId: ctx.rule.id },
    }),
  );
  return 'success';
}

/**
 * push_to_connector — request that an approved finance transaction be pushed to the configured mock
 * ERP. We emit a ConnectorPushRequested event (idempotency-keyed) rather than calling the connector
 * inline, so the owning service performs the push within its own authority/transaction. The mock
 * ERP framework (@aegis/connectors) consumes it via ConnectorRegistry.get(kind).pushTransaction(...).
 */
async function pushToConnector(ctx: ActionContext, action: ActionSpec): Promise<ActionStatus> {
  const connectorKind =
    (action.config['connectorKind'] as ConnectorKind | undefined) ?? ConnectorKind.LedgerOne;
  const entity =
    (action.config['entity'] as ConnectorEntity | undefined) ?? ConnectorEntity.Invoice;
  await getBus().publish(
    makeEnvelope(EventTopic.ConnectorPushRequested, {
      connectorKind,
      entity,
      idempotencyKey: `${ctx.rule.id}:${String(ctx.record['id'] ?? randomUUID())}`,
      ...recordRef(ctx),
      data: ctx.record,
      ruleId: ctx.rule.id,
    }),
  );
  return 'success';
}

/** Register the built-in action handlers (called once at bootstrap). */
export function registerBuiltinActions(): void {
  registerAction(RuleActionType.AutoApprove, autoApprove);
  registerAction(RuleActionType.AssignApprovalPolicy, assignApprovalPolicy);
  registerAction(RuleActionType.AssignTeam, assignTeam);
  registerAction(RuleActionType.AssignOwner, assignOwner);
  registerAction(RuleActionType.AddTag, addTag);
  registerAction(RuleActionType.Notify, notify);
  registerAction(RuleActionType.PushToConnector, pushToConnector);
}
