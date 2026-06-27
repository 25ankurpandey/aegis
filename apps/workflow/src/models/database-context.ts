import type { ModelStatic, Model, Sequelize } from 'sequelize';
import { getSequelize, createModelRegistry } from '@aegis/db';
import { defineRule } from './rule.model';
import { defineRuleStep } from './rule-step.model';
import { defineRuleAction } from './rule-action.model';
import { defineRuleAuditLog } from './rule-audit-log.model';
import { defineConnectorSyncState } from './connector-sync-state.model';
import { defineConnectorConfig } from './connector-config.model';

type M = ModelStatic<Model>;

/** The set of workflow (rules-as-data) models, registered on the shared connection (the DatabaseContext). */
export interface WorkflowContext {
  Rule: M;
  RuleStep: M;
  RuleAction: M;
  RuleAuditLog: M;
  /** Durable ERP push sync-state (connector_sync_state) — backs the connectors' DbSyncStateStore. */
  ConnectorSyncState: M;
  /** Per-tenant connector configuration resolved by the ERP-sync worker. */
  ConnectorConfig: M;
  sequelize: Sequelize;
}

let ctx: WorkflowContext | null = null;

/**
 * Defines every workflow model on the shared `getSequelize()` connection (once), wires the
 * associations, and returns the assembled context. The return shape is unchanged from the previous
 * single-file `context.ts`, so all callers keep working (SPEC §11.1 — one `*.model.ts` per table +
 * a `database-context.ts` that imports + registers them).
 */
export function getWorkflowContext(): WorkflowContext {
  if (ctx) return ctx;
  const s = getSequelize();
  // Single registration path through the registry (W2-09).
  const registry = createModelRegistry(s);

  const Rule = registry.register(defineRule(s));
  const RuleStep = registry.register(defineRuleStep(s));
  const RuleAction = registry.register(defineRuleAction(s));
  const RuleAuditLog = registry.register(defineRuleAuditLog(s));
  const ConnectorSyncState = registry.register(defineConnectorSyncState(s));
  const ConnectorConfig = registry.register(defineConnectorConfig(s));

  Rule.hasMany(RuleStep, { foreignKey: 'rule_id', as: 'steps' });
  Rule.hasMany(RuleAction, { foreignKey: 'rule_id', as: 'actions' });
  RuleStep.belongsTo(Rule, { foreignKey: 'rule_id', as: 'rule' });
  RuleAction.belongsTo(Rule, { foreignKey: 'rule_id', as: 'rule' });
  RuleAuditLog.belongsTo(Rule, { foreignKey: 'rule_id', as: 'rule' });

  ctx = { Rule, RuleStep, RuleAction, RuleAuditLog, ConnectorSyncState, ConnectorConfig, sequelize: s };
  return ctx;
}
