import type { Transaction } from 'sequelize';
import { inject } from 'inversify';
import { ErrUtils, Logger, RequestContext } from '@aegis/service-core';
import { PaginationConstants } from '@aegis/shared-constants';
import { RuleActionType, RuleRunStatus } from '@aegis/shared-enums';
import { WorkflowShape } from '@aegis/shared-types';
import { withTenantTransaction } from '@aegis/db';
import { ActivityLogger } from '@aegis/activity';
import { provideSingleton } from '../ioc/container';
import { RuleRepository } from '../repositories/rule.repository';
import { evaluateStep } from '../engine/evaluate-step';
import { aggregateVerdict } from '../engine/aggregate';
import { getActionHandler } from '../engine/actions/registry';
import { registerBuiltinEngine } from '../engine';
import type { ActionContext, ActionSpec, ActionStatus, Facts } from '../engine/types';

/**
 * The workflow engine service. Owns rule authoring + the evaluation pipeline:
 * load active rules for the event → evaluate steps (AND/OR) → dispatch matched actions →
 * fold per-action statuses into one verdict → append rule_audit_logs + stamp last_run.
 */
@provideSingleton(RuleService)
export class RuleService {
  constructor(@inject(RuleRepository) private readonly repo: RuleRepository) {
    registerBuiltinEngine(); // idempotent: ensure validators + action handlers are registered
  }

  // ---- Authoring (PEP-guarded HTTP surface) ----

  async createRule(input: WorkflowShape.CreateRuleInput): Promise<WorkflowShape.RuleDetail> {
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      const rule = await this.repo.createRule(
        { tenant_id: tenantId, name: input.name, event: input.event, active: input.active ?? true },
        t,
      );
      const steps = await this.repo.createSteps(
        input.steps.map((s) => ({ tenant_id: tenantId, rule_id: rule.id, order: s.order, query: s.query })),
        t,
      );
      const actions = await this.repo.createActions(
        input.actions.map((a) => ({ tenant_id: tenantId, rule_id: rule.id, type: a.type, config: a.config ?? {} })),
        t,
      );
      // W5-13 — append rule creation to the SHARED polymorphic business timeline (keyed `rule`/ruleId),
      // alongside the existing rule_audit_logs. Same RLS tx so tenant scoping holds on write.
      await this.writeActivity(
        rule.id,
        'created',
        { name: rule.name, event: rule.event, stepCount: steps.length, actionCount: actions.length },
        t,
      );
      return { ...rule, steps, actions };
    });
  }

  async listRules(page?: number, pageSize?: number): Promise<WorkflowShape.RuleListResult> {
    const p = Math.max(page ?? PaginationConstants.DefaultPage, 1);
    const size = Math.min(pageSize ?? PaginationConstants.DefaultPageSize, PaginationConstants.MaxPageSize);
    return withTenantTransaction(async (t) => {
      const { rows, total } = await this.repo.listRules({ limit: size, offset: (p - 1) * size }, t);
      return { data: rows, meta: { total, page: p, pageSize: size } };
    });
  }

  async getRule(id: string): Promise<WorkflowShape.RuleDetail> {
    return withTenantTransaction((t) => this.loadRuleDetail(id, t));
  }

  private async loadRuleDetail(id: string, t: Transaction): Promise<WorkflowShape.RuleDetail> {
    const rule = await this.repo.findRuleById(id, t);
    if (!rule) throw ErrUtils.notFound('Rule not found');
    const [steps, actions] = await Promise.all([this.repo.findSteps(id, t), this.repo.findActions(id, t)]);
    return { ...rule, steps, actions };
  }

  // ---- Evaluation engine ----

  /**
   * Run every active rule for `event` against the supplied facts. Each rule: evaluate its steps in
   * order, dispatch actions only if ALL steps pass, fold per-action statuses into a verdict, and
   * append one audit row (stamping last_run). Returns one verdict per rule considered.
   */
  async evaluateRules(event: string, facts: Facts): Promise<WorkflowShape.RunVerdict[]> {
    return withTenantTransaction(async (t) => {
      const rules = await this.repo.findActiveByEvent(event, t);
      const verdicts: WorkflowShape.RunVerdict[] = [];
      for (const rule of rules) {
        verdicts.push(await this.executeRule(rule, facts, t));
      }
      return verdicts;
    });
  }

  /** Manual run / dry-run of a single rule against a supplied facts payload (operator path). */
  async runRule(id: string, facts: Facts, dryRun = false): Promise<WorkflowShape.RunVerdict> {
    return withTenantTransaction(async (t) => {
      const rule = await this.repo.findRuleById(id, t);
      if (!rule) throw ErrUtils.notFound('Rule not found');
      return this.executeRule(rule, facts, t, dryRun);
    });
  }

  /** Evaluate one rule against one facts payload inside the given RLS transaction. */
  private async executeRule(
    rule: WorkflowShape.RuleRow,
    facts: Facts,
    t: Transaction,
    dryRun = false,
  ): Promise<WorkflowShape.RunVerdict> {
    const tenantId = RequestContext.tenantId();
    const steps = await this.repo.findSteps(rule.id, t);
    const stepTrace: Array<{ order: number; pass: boolean; trace: unknown }> = [];

    // Conditions pass only when ALL steps pass (short-circuit on first failure).
    let allPass = true;
    for (const step of steps) {
      const { pass, trace } = await evaluateStep({ record: facts, tenantId }, step.query);
      stepTrace.push({ order: step.order, pass, trace });
      if (!pass) {
        allPass = false;
        break;
      }
    }

    if (!allPass) {
      const detail = { steps: stepTrace, actions: [], dryRun, reason: 'not_passed_all_steps' };
      await this.repo.appendAudit({ tenant_id: tenantId, rule_id: rule.id, status: RuleRunStatus.Skipped, detail }, t);
      await this.repo.touchLastRun(rule.id, new Date(), t);
      return { ruleId: rule.id, status: RuleRunStatus.Skipped, detail };
    }

    // W5-13 — the rule's conditions matched: record the TRIGGER on the shared timeline. Dry-runs are
    // condition-only previews with no side effects, so they are not logged as a live trigger.
    if (!dryRun) {
      await this.writeActivity(
        rule.id,
        'triggered',
        { event: rule.event, recordType: facts.record_type, recordId: facts.id },
        t,
      );
    }

    const actions = await this.repo.findActions(rule.id, t);
    const actionResults: Array<{ type: string; status: ActionStatus }> = [];
    const ctx: ActionContext = { tenantId, record: facts, rule: { id: rule.id, name: rule.name, event: rule.event } };

    for (const action of actions) {
      const spec: ActionSpec = { type: action.type as RuleActionType, config: action.config };
      let status: ActionStatus;
      try {
        // Dry-run never performs side effects; it reports the action as skipped.
        status = dryRun ? 'skip' : await getActionHandler(spec.type)(ctx, spec);
      } catch (err) {
        Logger.error(err as Error, 'WORKFLOW_ACTION', action.type);
        status = 'error';
      }
      actionResults.push({ type: action.type, status });
    }

    const verdict = aggregateVerdict(actionResults.map((r) => r.status));
    const detail = { steps: stepTrace, actions: actionResults, dryRun };
    await this.repo.appendAudit({ tenant_id: tenantId, rule_id: rule.id, status: verdict, detail }, t);
    await this.repo.touchLastRun(rule.id, new Date(), t);

    // W5-13 — record the dispatched ACTIONS on the shared timeline (one summarising entry carrying the
    // per-action type+status). Only for live runs that actually performed side effects (dry-runs skip).
    if (!dryRun && actionResults.length > 0) {
      await this.writeActivity(
        rule.id,
        'actions_dispatched',
        { verdict, actions: actionResults, recordType: facts.record_type, recordId: facts.id },
        t,
      );
    }

    return { ruleId: rule.id, status: verdict, detail };
  }

  /**
   * Append to the SHARED, polymorphic business timeline (@aegis/activity), keyed by `(rule, ruleId)` —
   * the cross-service who-did-what feed (the reusable pattern expense/invoice/payroll copy), ADDITIVE
   * alongside the per-rule `rule_audit_logs`. Always called inside the active RLS-scoped tx so tenant
   * scoping holds on write; the actor defaults from the ambient RequestContext (null on the bus path,
   * where an auto-triggered run carries propagated tenant/correlation but no acting user).
   */
  private async writeActivity(
    ruleId: string,
    action: string,
    details: Record<string, unknown>,
    t: Transaction,
  ): Promise<void> {
    await ActivityLogger.record({ recordType: 'rule', recordId: ruleId, action, details }, t);
  }
}
