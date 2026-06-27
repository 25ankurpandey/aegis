import type {
  ConnectorEntity,
  ConnectorKind,
  ConnectorSyncStatus,
  RuleActionType,
  RuleConjunction,
  RuleOperator,
  RuleRunStatus,
} from '@aegis/shared-enums';

/**
 * Domain contract for the workflow service (the rules-as-data engine). Service-local DTOs, repository
 * row shapes, service inputs/results, and the predicate/facts data contracts all live here
 * (SPEC §11.2 — no domain types defined inside the service). Controllers, services, repositories, and
 * the engine import these from `@aegis/shared-types`; nothing workflow-domain-typed is declared locally.
 */
export namespace WorkflowShape {
  // ---- Rule data contract (the JSONB shapes carried on rule_step.query + the facts payload) ----

  /** One entry of a rule_step.query JSONB array — a single header-level predicate. */
  export interface Predicate {
    field: string; // attribute name, resolved by the validator registry
    operator: RuleOperator; // comparison
    value: unknown; // scalar, [lo, hi] for `between`, or array for `in`
    conjunction: RuleConjunction; // how this predicate combines (AND bucket vs OR bucket)
  }

  /** Header-level attributes carried on the triggering event/facts payload. */
  export type Facts = Record<string, unknown>;

  // ---- Persistence row shapes (what repositories return; `*.get({ plain: true })`) ----

  /** A row of the `rules` table. */
  export interface RuleRow {
    id: string;
    tenant_id: string;
    name: string;
    event: string;
    active: boolean;
    last_run: Date | null;
    created_at: Date;
    updated_at: Date;
  }

  /** A row of the `rule_steps` table (the ordered condition groups; `query` is a Predicate[] JSONB). */
  export interface RuleStepRow {
    id: string;
    tenant_id: string;
    rule_id: string;
    order: number;
    query: Predicate[];
  }

  /** A row of the `rule_actions` table (a typed side-effect with free-form config). */
  export interface RuleActionRow {
    id: string;
    tenant_id: string;
    rule_id: string;
    type: string;
    config: Record<string, unknown>;
  }

  /** A row of the `rule_audit_logs` table (one immutable verdict per rule execution). */
  export interface RuleAuditLogRow {
    id: string;
    tenant_id: string;
    rule_id: string;
    status: string;
    detail: Record<string, unknown>;
    created_at: Date;
  }

  /** A row of `connector_configs`, one active config per tenant + connector kind. */
  export interface ConnectorConfigRow {
    id: string;
    tenant_id: string;
    kind: ConnectorKind;
    active: boolean;
    base_url: string | null;
    credentials_ref: string | null;
    settings: Record<string, unknown>;
    created_by: string | null;
    updated_by: string | null;
    created_at: Date;
    updated_at: Date;
  }

  /** A row of `connector_sync_state`, the durable lifecycle for one outbound ERP push. */
  export interface ConnectorSyncStateRow {
    id: string;
    tenant_id: string;
    kind: ConnectorKind;
    entity: ConnectorEntity;
    record_id: string;
    idempotency_key: string;
    status: ConnectorSyncStatus;
    external_id: string | null;
    attempts: number;
    last_error: string | null;
    created_at: Date;
    updated_at: Date;
  }

  // ---- Repository write inputs ----

  /** Input to create a `rules` row. */
  export interface CreateRuleRow {
    tenant_id: string;
    name: string;
    event: string;
    active: boolean;
  }

  /** Input to create a `rule_steps` row. */
  export interface CreateRuleStepRow {
    tenant_id: string;
    rule_id: string;
    order: number;
    query: Predicate[];
  }

  /** Input to create a `rule_actions` row. */
  export interface CreateRuleActionRow {
    tenant_id: string;
    rule_id: string;
    type: string;
    config: Record<string, unknown>;
  }

  /** Input to append a `rule_audit_logs` row. */
  export interface AppendAuditRow {
    tenant_id: string;
    rule_id: string;
    status: string;
    detail: Record<string, unknown>;
  }

  // ---- Service inputs (the public method args) ----

  /** Args to `RuleService.createRule`. */
  export interface CreateRuleInput {
    name: string;
    event: string;
    active?: boolean;
    steps: Array<{ order: number; query: Predicate[] }>;
    actions: Array<{ type: RuleActionType; config?: Record<string, unknown> }>;
  }

  /** Args to `RuleService.runRule` (the operator manual/dry-run path). */
  export interface RunRuleInput {
    facts: Facts;
    dryRun?: boolean;
  }

  /** Args to create/update a tenant connector config. */
  export interface UpsertConnectorConfigInput {
    active?: boolean;
    baseUrl?: string | null;
    credentialsRef?: string | null;
    settings?: Record<string, unknown>;
  }

  /** Operator query for sync-state rows. */
  export interface ConnectorSyncStateQuery {
    page?: number;
    pageSize?: number;
    kind?: ConnectorKind;
    status?: ConnectorSyncStatus;
  }

  /** Operator request for a tenant-scoped connector status reconciliation sweep. */
  export interface ConnectorReconcileInput {
    limit?: number;
  }

  /** Repository input after page clamping. */
  export interface ListConnectorSyncStateInput {
    kind?: ConnectorKind;
    status?: ConnectorSyncStatus;
    limit: number;
    offset: number;
  }

  // ---- Service result DTOs (the explicit response shapes) ----

  /** A rule with its ordered steps + actions hydrated (the create/get response). */
  export interface RuleDetail extends RuleRow {
    steps: RuleStepRow[];
    actions: RuleActionRow[];
  }

  /** The verdict folded from one rule execution (the run/dry-run response). */
  export interface RunVerdict {
    ruleId: string;
    status: RuleRunStatus;
    detail: Record<string, unknown>;
  }

  /** A page of rules (the list response). */
  export interface RuleListResult {
    data: RuleRow[];
    meta: { total: number; page: number; pageSize: number };
  }

  export interface ConnectorConfigDto {
    id: string;
    kind: ConnectorKind;
    active: boolean;
    baseUrl: string | null;
    credentialsRef: string | null;
    settings: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }

  export interface ConnectorHealthDto {
    kind: ConnectorKind;
    healthy: boolean;
  }

  export interface ConnectorSyncStateDto {
    id: string;
    kind: ConnectorKind;
    entity: ConnectorEntity;
    recordId: string;
    idempotencyKey: string;
    status: ConnectorSyncStatus;
    externalId: string | null;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
  }

  export interface ConnectorSyncStateListResult {
    data: ConnectorSyncStateDto[];
    meta: { total: number; page: number; pageSize: number };
  }

  export interface ConnectorReconcileResult {
    data: {
      limit: number;
      advanced: number;
    };
  }
}
