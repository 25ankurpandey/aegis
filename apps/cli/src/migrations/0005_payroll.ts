import { DataTypes, Sequelize, type QueryInterface } from 'sequelize';
import type { MigrationParams } from 'umzug';
import {
  TableName,
  PayRunStatus,
  PayRunType,
  PayItemKind,
  PaymentStatus,
  PayrollInputStatus,
  LedgerAccount,
  EmploymentStatus,
  ContractType,
  PayFrequency,
  PayslipStatus,
  PayslipLineSource,
  SettlementMode,
  TaxRuleType,
} from '@aegis/shared-enums';
import { rlsPolicyStatements } from '@aegis/db';

const uuidPk = {
  type: DataTypes.UUID,
  primaryKey: true,
  defaultValue: Sequelize.literal('gen_random_uuid()'),
};
const timestamps = {
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
  updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
};
/** Mutable-entity audit columns (who created / last updated the row). Nullable: system seeds + back-fill. */
const auditCols = {
  created_by: { type: DataTypes.UUID, allowNull: true },
  updated_by: { type: DataTypes.UUID, allowNull: true },
};
/** Paranoid soft-delete column for long-lived master entities (Sequelize `paranoid: true`). */
const softDelete = {
  deleted_at: { type: DataTypes.DATE, allowNull: true },
};
/** Optimistic-lock counter (Sequelize `version: 'lock_version'`) for mutable aggregate roots. */
const lockVersion = {
  lock_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
};
const tenantFk = {
  type: DataTypes.UUID,
  allowNull: false,
  references: { model: TableName.Tenants, key: 'id' },
  onDelete: 'CASCADE',
};

/**
 * CHECK value sets, each derived from its `@aegis/shared-enums` source of truth (SPEC §11.2). The
 * enum is the single authority for the column's domain — the CHECK, the DTO type, and write sites
 * all consume it — so the constraint can never drift from the values the service writes.
 */
/** Employee lifecycle (default 'active'). */
const EMPLOYMENT_STATUSES = Object.values(EmploymentStatus);
/** Employment-contract kind (default 'salaried'). */
const CONTRACT_TYPES = Object.values(ContractType);
/** Pay frequencies — pay_calendars.frequency, employment_contracts.pay_frequency, employee_pay_items.frequency (default 'monthly'). */
const PAY_FREQUENCIES = Object.values(PayFrequency);
/** Payslip lifecycle (default 'draft'). */
const PAYSLIP_STATUSES = Object.values(PayslipStatus);
/** Payslip-line / employee-pay-item kind — the pay-item taxonomy. */
const PAY_ITEM_KINDS = Object.values(PayItemKind);
/** Payslip-line source (default 'base'). */
const PAYSLIP_LINE_SOURCES = Object.values(PayslipLineSource);
/** Payroll-input settlement timing (default 'cyclic'). */
const SETTLEMENT_MODES = Object.values(SettlementMode);
/** Tax-rule rule_type taxonomy. */
const TAX_RULE_TYPES = Object.values(TaxRuleType);

/** SQL `IN (...)` value list helper for a CHECK over a string enum. */
function inList(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

/** Custom RLS for tables whose isolation key is not a non-null `tenant_id` (e.g. nullable platform-default rows). */
function customRls(table: string, predicate: string): string[] {
  const policy = `${table}_isolation`;
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "${policy}" ON "${table}";`,
    `CREATE POLICY "${policy}" ON "${table}" AS RESTRICTIVE USING (${predicate});`,
  ];
}

export async function up({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.createTable(TableName.Employees, {
    id: uuidPk,
    tenant_id: tenantFk,
    person_ref: { type: DataTypes.UUID, allowNull: true },
    legal_entity_id: { type: DataTypes.UUID, allowNull: true },
    employment_status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'active' },
    work_jurisdiction: { type: DataTypes.STRING, allowNull: false },
    residence_jurisdiction: { type: DataTypes.STRING, allowNull: true },
    bank_account_enc: { type: DataTypes.TEXT, allowNull: true },
    national_id_enc: { type: DataTypes.TEXT, allowNull: true },
    tax_identifier_enc: { type: DataTypes.TEXT, allowNull: true },
    ...auditCols,
    ...timestamps,
    ...softDelete,
    ...lockVersion,
  });
  await q.addIndex(TableName.Employees, ['tenant_id'], { name: 'employees_tenant_idx' });
  await q.addConstraint(TableName.Employees, {
    type: 'check',
    name: 'employees_employment_status_chk',
    fields: ['employment_status'],
    where: Sequelize.literal(`"employment_status" IN (${inList(EMPLOYMENT_STATUSES)})`),
  });
  // Long-lived master entity: listed/filtered per tenant by lifecycle + recency.
  await q.addIndex(TableName.Employees, ['tenant_id', 'employment_status'], { name: 'employees_tenant_status_idx' });
  await q.addIndex(TableName.Employees, ['tenant_id', 'created_at'], { name: 'employees_tenant_created_at_idx' });

  await q.createTable(TableName.EmploymentContracts, {
    id: uuidPk,
    tenant_id: tenantFk,
    employee_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Employees, key: 'id' }, onDelete: 'CASCADE' },
    effective_from: { type: DataTypes.DATEONLY, allowNull: false },
    effective_to: { type: DataTypes.DATEONLY, allowNull: true },
    type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'salaried' },
    base_amount_enc: { type: DataTypes.TEXT, allowNull: true },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
    fte: { type: DataTypes.DECIMAL(5, 4), allowNull: true },
    pay_frequency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'monthly' },
    ...auditCols,
    ...timestamps,
  });
  await q.addIndex(TableName.EmploymentContracts, ['tenant_id', 'employee_id'], { name: 'contracts_tenant_employee_idx' });
  await q.addIndex(TableName.EmploymentContracts, ['tenant_id', 'created_at'], { name: 'contracts_tenant_created_at_idx' });
  await q.addConstraint(TableName.EmploymentContracts, {
    type: 'check',
    name: 'contracts_type_chk',
    fields: ['type'],
    where: Sequelize.literal(`"type" IN (${inList(CONTRACT_TYPES)})`),
  });
  await q.addConstraint(TableName.EmploymentContracts, {
    type: 'check',
    name: 'contracts_pay_frequency_chk',
    fields: ['pay_frequency'],
    where: Sequelize.literal(`"pay_frequency" IN (${inList(PAY_FREQUENCIES)})`),
  });
  await q.addConstraint(TableName.EmploymentContracts, {
    type: 'check',
    name: 'contracts_fte_nonneg_chk',
    fields: ['fte'],
    where: Sequelize.literal(`"fte" IS NULL OR "fte" >= 0`),
  });

  await q.createTable(TableName.PayCalendars, {
    id: uuidPk,
    tenant_id: tenantFk,
    name: { type: DataTypes.STRING, allowNull: false },
    frequency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'monthly' },
    period_start_rule: { type: DataTypes.STRING, allowNull: true },
    cutoff_rule: { type: DataTypes.STRING, allowNull: true },
    pay_date_rule: { type: DataTypes.STRING, allowNull: true },
    ...auditCols,
    ...timestamps,
    ...softDelete,
  });
  // Master entity: a calendar's name is its natural key within a tenant. Paranoid (soft-delete):
  // scope uniqueness to live rows so a name frees up after a soft-delete (avoids 23505 on recreate).
  await q.addIndex(TableName.PayCalendars, ['tenant_id', 'name'], {
    unique: true,
    name: 'pay_calendars_tenant_name_uq',
    where: { deleted_at: null },
  });
  await q.addIndex(TableName.PayCalendars, ['tenant_id', 'created_at'], { name: 'pay_calendars_tenant_created_at_idx' });
  await q.addConstraint(TableName.PayCalendars, {
    type: 'check',
    name: 'pay_calendars_frequency_chk',
    fields: ['frequency'],
    where: Sequelize.literal(`"frequency" IN (${inList(PAY_FREQUENCIES)})`),
  });

  await q.createTable(TableName.EarningCodes, {
    id: uuidPk,
    tenant_id: tenantFk,
    name: { type: DataTypes.STRING, allowNull: false },
    taxable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    recurring_default: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...auditCols,
    ...timestamps,
    ...softDelete,
  });
  // Master code catalog: name is the natural key within a tenant. Paranoid (soft-delete): scope
  // uniqueness to live rows so a name frees up after a soft-delete (avoids 23505 on recreate).
  await q.addIndex(TableName.EarningCodes, ['tenant_id', 'name'], {
    unique: true,
    name: 'earning_codes_tenant_name_uq',
    where: { deleted_at: null },
  });
  await q.addIndex(TableName.EarningCodes, ['tenant_id', 'created_at'], { name: 'earning_codes_tenant_created_at_idx' });

  await q.createTable(TableName.DeductionCodes, {
    id: uuidPk,
    tenant_id: tenantFk,
    name: { type: DataTypes.STRING, allowNull: false },
    pre_tax: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    employer_contribution: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...auditCols,
    ...timestamps,
    ...softDelete,
  });
  // Master code catalog: name is the natural key within a tenant. Paranoid (soft-delete): scope
  // uniqueness to live rows so a name frees up after a soft-delete (avoids 23505 on recreate).
  await q.addIndex(TableName.DeductionCodes, ['tenant_id', 'name'], {
    unique: true,
    name: 'deduction_codes_tenant_name_uq',
    where: { deleted_at: null },
  });
  await q.addIndex(TableName.DeductionCodes, ['tenant_id', 'created_at'], { name: 'deduction_codes_tenant_created_at_idx' });

  // tax_rules: tenant_id is NULLABLE — a null row is a seeded platform-default; a set row is tenant-specific.
  await q.createTable(TableName.TaxRules, {
    id: uuidPk,
    tenant_id: { type: DataTypes.UUID, allowNull: true, references: { model: TableName.Tenants, key: 'id' }, onDelete: 'CASCADE' },
    jurisdiction: { type: DataTypes.STRING, allowNull: false },
    rule_type: { type: DataTypes.STRING, allowNull: false },
    effective_from: { type: DataTypes.DATEONLY, allowNull: false },
    effective_to: { type: DataTypes.DATEONLY, allowNull: true },
    params: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    ...auditCols,
    ...timestamps,
    ...softDelete,
  });
  await q.addIndex(TableName.TaxRules, ['jurisdiction', 'rule_type'], { name: 'tax_rules_jurisdiction_type_idx' });
  await q.addIndex(TableName.TaxRules, ['tenant_id', 'created_at'], { name: 'tax_rules_tenant_created_at_idx' });
  await q.addConstraint(TableName.TaxRules, {
    type: 'check',
    name: 'tax_rules_rule_type_chk',
    fields: ['rule_type'],
    where: Sequelize.literal(`"rule_type" IN (${inList(TAX_RULE_TYPES)})`),
  });
  await q.addConstraint(TableName.TaxRules, {
    type: 'check',
    name: 'tax_rules_version_positive_chk',
    fields: ['version'],
    where: Sequelize.literal(`"version" >= 1`),
  });

  await q.createTable(TableName.EmployeePayItems, {
    id: uuidPk,
    tenant_id: tenantFk,
    employee_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Employees, key: 'id' }, onDelete: 'CASCADE' },
    code_id: { type: DataTypes.UUID, allowNull: true },
    code_kind: { type: DataTypes.STRING, allowNull: false },
    amount_or_rate: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    frequency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'monthly' },
    effective_from: { type: DataTypes.DATEONLY, allowNull: false },
    effective_to: { type: DataTypes.DATEONLY, allowNull: true },
    ...auditCols,
    ...timestamps,
  });
  await q.addIndex(TableName.EmployeePayItems, ['tenant_id', 'employee_id'], { name: 'pay_items_tenant_employee_idx' });
  await q.addIndex(TableName.EmployeePayItems, ['tenant_id', 'created_at'], { name: 'pay_items_tenant_created_at_idx' });
  await q.addConstraint(TableName.EmployeePayItems, {
    type: 'check',
    name: 'pay_items_code_kind_chk',
    fields: ['code_kind'],
    where: Sequelize.literal(`"code_kind" IN (${inList(PAY_ITEM_KINDS)})`),
  });
  await q.addConstraint(TableName.EmployeePayItems, {
    type: 'check',
    name: 'pay_items_frequency_chk',
    fields: ['frequency'],
    where: Sequelize.literal(`"frequency" IN (${inList(PAY_FREQUENCIES)})`),
  });
  await q.addConstraint(TableName.EmployeePayItems, {
    type: 'check',
    name: 'pay_items_amount_nonneg_chk',
    fields: ['amount_or_rate'],
    where: Sequelize.literal(`"amount_or_rate" >= 0`),
  });

  await q.createTable(TableName.PayRuns, {
    id: uuidPk,
    tenant_id: tenantFk,
    pay_calendar_id: { type: DataTypes.UUID, allowNull: true, references: { model: TableName.PayCalendars, key: 'id' }, onDelete: 'SET NULL' },
    period_start: { type: DataTypes.DATEONLY, allowNull: false },
    period_end: { type: DataTypes.DATEONLY, allowNull: false },
    pay_date: { type: DataTypes.DATEONLY, allowNull: false },
    type: { type: DataTypes.STRING, allowNull: false, defaultValue: 'regular' },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'draft' },
    created_by: { type: DataTypes.UUID, allowNull: false },
    // created_by already exists (NOT NULL); add updated_by to complete the audit pair.
    updated_by: { type: DataTypes.UUID, allowNull: true },
    approved_by: { type: DataTypes.UUID, allowNull: true },
    approved_at: { type: DataTypes.DATE, allowNull: true },
    locked_snapshot: { type: DataTypes.JSONB, allowNull: true },
    ...timestamps,
    ...softDelete,
    ...lockVersion,
  });
  await q.addIndex(TableName.PayRuns, ['tenant_id', 'status'], { name: 'pay_runs_tenant_status_idx' });
  await q.addIndex(TableName.PayRuns, ['tenant_id', 'created_at'], { name: 'pay_runs_tenant_created_at_idx' });
  // FK index on the pay_calendar reference.
  await q.addIndex(TableName.PayRuns, ['pay_calendar_id'], { name: 'pay_runs_pay_calendar_idx' });
  // A tenant runs one pay-run per (calendar, period) — the natural dedupe key for a cycle.
  // `pay_runs` is paranoid (soft-delete): scope uniqueness to live rows so a soft-deleted (e.g.
  // voided) run does not block recreating the same cycle (avoids 23505 on recreate).
  await q.addIndex(TableName.PayRuns, ['tenant_id', 'pay_calendar_id', 'period_start', 'period_end', 'type'], {
    unique: true,
    name: 'pay_runs_tenant_period_uq',
    where: { deleted_at: null },
  });
  await q.addConstraint(TableName.PayRuns, {
    type: 'check',
    name: 'pay_runs_status_chk',
    fields: ['status'],
    where: Sequelize.literal(`"status" IN (${inList(Object.values(PayRunStatus))})`),
  });
  await q.addConstraint(TableName.PayRuns, {
    type: 'check',
    name: 'pay_runs_type_chk',
    fields: ['type'],
    where: Sequelize.literal(`"type" IN (${inList(Object.values(PayRunType))})`),
  });

  await q.createTable(TableName.Payslips, {
    id: uuidPk,
    tenant_id: tenantFk,
    pay_run_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.PayRuns, key: 'id' }, onDelete: 'CASCADE' },
    employee_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Employees, key: 'id' }, onDelete: 'CASCADE' },
    gross: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    taxable_base: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    total_tax: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    total_deductions: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    net_enc: { type: DataTypes.TEXT, allowNull: true },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'draft' },
    ...auditCols,
    ...timestamps,
  });
  await q.addIndex(TableName.Payslips, ['tenant_id', 'pay_run_id'], { name: 'payslips_tenant_run_idx' });
  await q.addIndex(TableName.Payslips, ['tenant_id', 'created_at'], { name: 'payslips_tenant_created_at_idx' });
  // FK index on employee_id (the run index leads with pay_run_id).
  await q.addIndex(TableName.Payslips, ['employee_id'], { name: 'payslips_employee_idx' });
  // One payslip per (run, employee) — the natural key for a run's per-employee result.
  await q.addIndex(TableName.Payslips, ['pay_run_id', 'employee_id'], { unique: true, name: 'payslips_run_employee_uq' });
  await q.addConstraint(TableName.Payslips, {
    type: 'check',
    name: 'payslips_status_chk',
    fields: ['status'],
    where: Sequelize.literal(`"status" IN (${inList(PAYSLIP_STATUSES)})`),
  });
  await q.addConstraint(TableName.Payslips, {
    type: 'check',
    name: 'payslips_amounts_nonneg_chk',
    fields: ['gross', 'taxable_base', 'total_tax', 'total_deductions'],
    where: Sequelize.literal(
      `"gross" >= 0 AND "taxable_base" >= 0 AND "total_tax" >= 0 AND "total_deductions" >= 0`,
    ),
  });

  await q.createTable(TableName.PayslipLines, {
    id: uuidPk,
    tenant_id: tenantFk,
    payslip_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Payslips, key: 'id' }, onDelete: 'CASCADE' },
    kind: { type: DataTypes.STRING, allowNull: false },
    code_id: { type: DataTypes.UUID, allowNull: true },
    source: { type: DataTypes.STRING, allowNull: false, defaultValue: 'base' },
    source_ref: { type: DataTypes.STRING, allowNull: true },
    amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    taxable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...auditCols,
    ...timestamps,
  });
  await q.addIndex(TableName.PayslipLines, ['tenant_id', 'payslip_id'], { name: 'payslip_lines_tenant_payslip_idx' });
  await q.addConstraint(TableName.PayslipLines, {
    type: 'check',
    name: 'payslip_lines_kind_chk',
    fields: ['kind'],
    where: Sequelize.literal(`"kind" IN (${inList(PAY_ITEM_KINDS)})`),
  });
  await q.addConstraint(TableName.PayslipLines, {
    type: 'check',
    name: 'payslip_lines_source_chk',
    fields: ['source'],
    where: Sequelize.literal(`"source" IN (${inList(PAYSLIP_LINE_SOURCES)})`),
  });
  await q.addConstraint(TableName.PayslipLines, {
    type: 'check',
    name: 'payslip_lines_amount_nonneg_chk',
    fields: ['amount'],
    where: Sequelize.literal(`"amount" >= 0`),
  });

  await q.createTable(TableName.PayrollInputItems, {
    id: uuidPk,
    tenant_id: tenantFk,
    employee_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Employees, key: 'id' }, onDelete: 'CASCADE' },
    source: { type: DataTypes.STRING, allowNull: false },
    source_ref: { type: DataTypes.STRING, allowNull: true },
    idempotency_key: { type: DataTypes.STRING, allowNull: false, unique: true },
    amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    taxable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    settlement: { type: DataTypes.STRING, allowNull: false, defaultValue: 'cyclic' },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
    ...auditCols,
    ...timestamps,
  });
  await q.addIndex(TableName.PayrollInputItems, ['idempotency_key'], { unique: true, name: 'payroll_inputs_idempotency_uq' });
  // FK index + per-tenant listing/filtering by status and recency.
  await q.addIndex(TableName.PayrollInputItems, ['employee_id'], { name: 'payroll_inputs_employee_idx' });
  await q.addIndex(TableName.PayrollInputItems, ['tenant_id', 'status'], { name: 'payroll_inputs_tenant_status_idx' });
  await q.addIndex(TableName.PayrollInputItems, ['tenant_id', 'created_at'], { name: 'payroll_inputs_tenant_created_at_idx' });
  await q.addConstraint(TableName.PayrollInputItems, {
    type: 'check',
    name: 'payroll_inputs_status_chk',
    fields: ['status'],
    where: Sequelize.literal(`"status" IN (${inList(Object.values(PayrollInputStatus))})`),
  });
  await q.addConstraint(TableName.PayrollInputItems, {
    type: 'check',
    name: 'payroll_inputs_settlement_chk',
    fields: ['settlement'],
    where: Sequelize.literal(`"settlement" IN (${inList(SETTLEMENT_MODES)})`),
  });
  await q.addConstraint(TableName.PayrollInputItems, {
    type: 'check',
    name: 'payroll_inputs_amount_nonneg_chk',
    fields: ['amount'],
    where: Sequelize.literal(`"amount" >= 0`),
  });

  await q.createTable(TableName.PaymentBatches, {
    id: uuidPk,
    tenant_id: tenantFk,
    pay_run_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.PayRuns, key: 'id' }, onDelete: 'CASCADE' },
    file_ref: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
    ...auditCols,
    ...timestamps,
  });
  // FK index + per-tenant listing/filtering by status and recency.
  await q.addIndex(TableName.PaymentBatches, ['pay_run_id'], { name: 'payment_batches_pay_run_idx' });
  await q.addIndex(TableName.PaymentBatches, ['tenant_id', 'status'], { name: 'payment_batches_tenant_status_idx' });
  await q.addIndex(TableName.PaymentBatches, ['tenant_id', 'created_at'], { name: 'payment_batches_tenant_created_at_idx' });
  await q.addConstraint(TableName.PaymentBatches, {
    type: 'check',
    name: 'payment_batches_status_chk',
    fields: ['status'],
    where: Sequelize.literal(`"status" IN (${inList(Object.values(PaymentStatus))})`),
  });

  await q.createTable(TableName.Payments, {
    id: uuidPk,
    tenant_id: tenantFk,
    payslip_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.Payslips, key: 'id' }, onDelete: 'CASCADE' },
    batch_id: { type: DataTypes.UUID, allowNull: true, references: { model: TableName.PaymentBatches, key: 'id' }, onDelete: 'SET NULL' },
    amount: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
    status: { type: DataTypes.STRING, allowNull: false, defaultValue: 'pending' },
    idempotency_key: { type: DataTypes.STRING, allowNull: false, unique: true },
    rail_ref: { type: DataTypes.STRING, allowNull: true },
    ...timestamps,
  });
  // Idempotency key is the disbursement dedupe key (append-only: no audit/soft-delete columns).
  await q.addIndex(TableName.Payments, ['idempotency_key'], { unique: true, name: 'payments_idempotency_uq' });
  // FK indexes + per-tenant listing/filtering by status and recency.
  await q.addIndex(TableName.Payments, ['payslip_id'], { name: 'payments_payslip_idx' });
  await q.addIndex(TableName.Payments, ['batch_id'], { name: 'payments_batch_idx' });
  await q.addIndex(TableName.Payments, ['tenant_id', 'status'], { name: 'payments_tenant_status_idx' });
  await q.addIndex(TableName.Payments, ['tenant_id', 'created_at'], { name: 'payments_tenant_created_at_idx' });
  await q.addConstraint(TableName.Payments, {
    type: 'check',
    name: 'payments_status_chk',
    fields: ['status'],
    where: Sequelize.literal(`"status" IN (${inList(Object.values(PaymentStatus))})`),
  });
  await q.addConstraint(TableName.Payments, {
    type: 'check',
    name: 'payments_amount_nonneg_chk',
    fields: ['amount'],
    where: Sequelize.literal(`"amount" >= 0`),
  });

  // Append-only double-entry ledger. No update/delete path; corrections post a reversal entry.
  await q.createTable(TableName.LedgerEntries, {
    id: uuidPk,
    tenant_id: tenantFk,
    pay_run_id: { type: DataTypes.UUID, allowNull: false, references: { model: TableName.PayRuns, key: 'id' }, onDelete: 'CASCADE' },
    account: { type: DataTypes.STRING, allowNull: false },
    debit: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    credit: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    currency: { type: DataTypes.STRING, allowNull: false, defaultValue: 'USD' },
    reversal_of: { type: DataTypes.UUID, allowNull: true },
    posted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('now()') },
    ...timestamps,
  });
  await q.addIndex(TableName.LedgerEntries, ['tenant_id', 'pay_run_id'], { name: 'ledger_tenant_run_idx' });
  // FK index on pay_run_id (the composite leads with tenant_id) + the self-referential reversal link.
  await q.addIndex(TableName.LedgerEntries, ['pay_run_id'], { name: 'ledger_pay_run_idx' });
  await q.addIndex(TableName.LedgerEntries, ['reversal_of'], { name: 'ledger_reversal_of_idx' });
  await q.addIndex(TableName.LedgerEntries, ['tenant_id', 'created_at'], { name: 'ledger_tenant_created_at_idx' });
  await q.addConstraint(TableName.LedgerEntries, {
    type: 'check',
    name: 'ledger_account_chk',
    fields: ['account'],
    where: Sequelize.literal(`"account" IN (${inList(Object.values(LedgerAccount))})`),
  });
  // Double-entry: each leg is unsigned; a row carries either a debit or a credit (or zero), never negative.
  await q.addConstraint(TableName.LedgerEntries, {
    type: 'check',
    name: 'ledger_debit_credit_nonneg_chk',
    fields: ['debit', 'credit'],
    where: Sequelize.literal(`"debit" >= 0 AND "credit" >= 0`),
  });

  // Row-Level Security — FORCE + RESTRICTIVE on every tenant-scoped table.
  const stmts = [
    ...rlsPolicyStatements(TableName.Employees),
    ...rlsPolicyStatements(TableName.EmploymentContracts),
    ...rlsPolicyStatements(TableName.PayCalendars),
    ...rlsPolicyStatements(TableName.EarningCodes),
    ...rlsPolicyStatements(TableName.DeductionCodes),
    // tax_rules: null tenant_id rows are platform defaults visible to all tenants.
    ...customRls(TableName.TaxRules, `tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant', true)::uuid`),
    ...rlsPolicyStatements(TableName.EmployeePayItems),
    ...rlsPolicyStatements(TableName.PayRuns),
    ...rlsPolicyStatements(TableName.Payslips),
    ...rlsPolicyStatements(TableName.PayslipLines),
    ...rlsPolicyStatements(TableName.PayrollInputItems),
    ...rlsPolicyStatements(TableName.PaymentBatches),
    ...rlsPolicyStatements(TableName.Payments),
    ...rlsPolicyStatements(TableName.LedgerEntries),
    // Enforce ledger append-only: block UPDATE/DELETE at the database.
    `ALTER TABLE "${TableName.LedgerEntries}" ENABLE ROW LEVEL SECURITY;`,
    `DROP POLICY IF EXISTS "ledger_entries_append_only" ON "${TableName.LedgerEntries}";`,
    `CREATE POLICY "ledger_entries_append_only" ON "${TableName.LedgerEntries}" AS RESTRICTIVE FOR UPDATE USING (false);`,
    `DROP POLICY IF EXISTS "ledger_entries_no_delete" ON "${TableName.LedgerEntries}";`,
    `CREATE POLICY "ledger_entries_no_delete" ON "${TableName.LedgerEntries}" AS RESTRICTIVE FOR DELETE USING (false);`,
  ];
  for (const stmt of stmts) {
    await q.sequelize.query(stmt);
  }
}

export async function down({ context: q }: MigrationParams<QueryInterface>): Promise<void> {
  await q.dropTable(TableName.LedgerEntries);
  await q.dropTable(TableName.Payments);
  await q.dropTable(TableName.PaymentBatches);
  await q.dropTable(TableName.PayrollInputItems);
  await q.dropTable(TableName.PayslipLines);
  await q.dropTable(TableName.Payslips);
  await q.dropTable(TableName.PayRuns);
  await q.dropTable(TableName.EmployeePayItems);
  await q.dropTable(TableName.TaxRules);
  await q.dropTable(TableName.DeductionCodes);
  await q.dropTable(TableName.EarningCodes);
  await q.dropTable(TableName.PayCalendars);
  await q.dropTable(TableName.EmploymentContracts);
  await q.dropTable(TableName.Employees);
}
