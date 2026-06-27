import type { Transaction } from 'sequelize';
import { WorkflowShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getWorkflowContext } from '../models/database-context';

/**
 * Data access for the rule aggregate (`rules` + its `rule_steps`/`rule_actions` children + the
 * append-only `rule_audit_logs`). Every method takes the ambient RLS-scoped `Transaction` (the
 * SERVICE opens it via `withTenantTransaction`), so a tenant only ever sees its own rows.
 */
@provideSingleton(RuleRepository)
export class RuleRepository {
  async createRule(data: WorkflowShape.CreateRuleRow, t: Transaction): Promise<WorkflowShape.RuleRow> {
    const { Rule } = getWorkflowContext();
    const row = await Rule.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as WorkflowShape.RuleRow;
  }

  async createSteps(steps: WorkflowShape.CreateRuleStepRow[], t: Transaction): Promise<WorkflowShape.RuleStepRow[]> {
    if (steps.length === 0) return [];
    const { RuleStep } = getWorkflowContext();
    const rows = await RuleStep.bulkCreate(steps.map((s) => ({ ...s })), { transaction: t });
    return rows.map((r) => r.get({ plain: true }) as WorkflowShape.RuleStepRow);
  }

  async createActions(actions: WorkflowShape.CreateRuleActionRow[], t: Transaction): Promise<WorkflowShape.RuleActionRow[]> {
    if (actions.length === 0) return [];
    const { RuleAction } = getWorkflowContext();
    const rows = await RuleAction.bulkCreate(actions.map((a) => ({ ...a })), { transaction: t });
    return rows.map((r) => r.get({ plain: true }) as WorkflowShape.RuleActionRow);
  }

  async findRuleById(id: string, t: Transaction): Promise<WorkflowShape.RuleRow | null> {
    const { Rule } = getWorkflowContext();
    const row = await Rule.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as WorkflowShape.RuleRow) : null;
  }

  /** Active rules for a given trigger event (RLS already fences to the current tenant). */
  async findActiveByEvent(event: string, t: Transaction): Promise<WorkflowShape.RuleRow[]> {
    const { Rule } = getWorkflowContext();
    const rows = await Rule.findAll({ where: { event, active: true }, transaction: t });
    return rows.map((r) => r.get({ plain: true }) as WorkflowShape.RuleRow);
  }

  async listRules(
    opts: { limit: number; offset: number },
    t: Transaction,
  ): Promise<{ rows: WorkflowShape.RuleRow[]; total: number }> {
    const { Rule } = getWorkflowContext();
    const { rows, count } = await Rule.findAndCountAll({
      limit: opts.limit,
      offset: opts.offset,
      order: [['created_at', 'DESC']],
      transaction: t,
    });
    return { rows: rows.map((r) => r.get({ plain: true }) as WorkflowShape.RuleRow), total: count };
  }

  async findSteps(ruleId: string, t: Transaction): Promise<WorkflowShape.RuleStepRow[]> {
    const { RuleStep } = getWorkflowContext();
    const rows = await RuleStep.findAll({ where: { rule_id: ruleId }, order: [['order', 'ASC']], transaction: t });
    return rows.map((r) => r.get({ plain: true }) as WorkflowShape.RuleStepRow);
  }

  async findActions(ruleId: string, t: Transaction): Promise<WorkflowShape.RuleActionRow[]> {
    const { RuleAction } = getWorkflowContext();
    const rows = await RuleAction.findAll({ where: { rule_id: ruleId }, transaction: t });
    return rows.map((r) => r.get({ plain: true }) as WorkflowShape.RuleActionRow);
  }

  /** Stamp the rule's last_run watermark after an execution. */
  async touchLastRun(ruleId: string, at: Date, t: Transaction): Promise<void> {
    const { Rule } = getWorkflowContext();
    await Rule.update({ last_run: at }, { where: { id: ruleId }, transaction: t });
  }

  /** Append one immutable verdict row for a rule execution. */
  async appendAudit(data: WorkflowShape.AppendAuditRow, t: Transaction): Promise<WorkflowShape.RuleAuditLogRow> {
    const { RuleAuditLog } = getWorkflowContext();
    const row = await RuleAuditLog.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as WorkflowShape.RuleAuditLogRow;
  }
}
