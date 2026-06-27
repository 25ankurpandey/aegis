import type {
  EmploymentStatus,
  PayRunType,
  PayslipStatus,
  TaxRuleType,
} from '@aegis/shared-enums';

/**
 * Domain contract for the payroll service (employee master data + the pay-run engine).
 * Service-local DTOs, repository row shapes, and repository/service inputs all live here
 * (SPEC §11.2 — no domain types defined inside the service). Controllers, services, and
 * repositories import these from `@aegis/shared-types`; nothing payroll-domain-typed is
 * declared locally.
 */
export namespace PayrollShape {
  // ---- Persistence row shapes (what repositories return; `*.get({ plain: true })`) ----

  /** A row of the `employees` table (sensitive PII columns are stored AES-256-GCM encrypted). */
  export interface EmployeeRow {
    id: string;
    tenant_id: string;
    /** Optional identity binding used for `payroll.payslip.view.own`. */
    user_id: string | null;
    person_ref: string | null;
    legal_entity_id: string | null;
    employment_status: EmploymentStatus;
    work_jurisdiction: string;
    residence_jurisdiction: string | null;
    bank_account_enc: string | null;
    national_id_enc: string | null;
    tax_identifier_enc: string | null;
  }

  /** A row of the `pay_runs` table (the lifecycle aggregate root: Draft → Calculated → Approved → Paid). */
  export interface PayRunRow {
    id: string;
    tenant_id: string;
    pay_calendar_id: string | null;
    period_start: string;
    period_end: string;
    pay_date: string;
    type: string;
    status: string;
    created_by: string;
    approved_by: string | null;
    approved_at: Date | null;
    locked_snapshot: unknown;
    /** Owning team set by a workflow `assign_team` rule action (via the RecordUpdated follow-on). */
    team_id?: string | null;
    /** Current assignee/owner set by a workflow/manual assignment (via the RecordUpdated follow-on). */
    assignee_id?: string | null;
    /** Classification tags attached by a workflow `add_tag` rule action (unioned, distinct). */
    tags?: string[] | null;
    /** Optimistic-lock counter (Sequelize `version` mapped to `lock_version`); guards status races (W5-07). */
    lock_version?: number;
  }

  /** A row of the `payslips` table (net pay is field-encrypted in `net_enc`). */
  export interface PayslipRow {
    id: string;
    tenant_id: string;
    pay_run_id: string;
    employee_id: string;
    gross: number;
    taxable_base: number;
    total_tax: number;
    total_deductions: number;
    net_enc: string | null;
    currency: string;
    status: string;
  }

  /** A row of the `employee_pay_items` table (recurring/one-off earnings + deductions). */
  export interface EmployeePayItemRow {
    id: string;
    tenant_id: string;
    employee_id: string;
    code_id: string | null;
    code_kind: string;
    amount_or_rate: number;
    frequency: string;
    effective_from: string;
    effective_to: string | null;
  }

  /** A row of the `deduction_codes` catalog (the `*pre_tax` flag drives the taxable-base reduction). */
  export interface DeductionCodeRow {
    id: string;
    tenant_id: string;
    name: string;
    /** Canonical pre-tax flag (0005 schema). The 0018 migration keeps this as the source of truth. */
    pre_tax?: boolean;
    /** Fallback pre-tax flag for a schema that adopted `is_pre_tax` instead of `pre_tax`. */
    is_pre_tax?: boolean;
    employer_contribution?: boolean;
  }

  /**
   * A row of the effective-dated, jurisdiction-keyed `tax_rules` table. `tenant_id IS NULL` is a
   * seeded platform-default; a set `tenant_id` is a tenant override. `params` carries the statutory
   * math as DATA (no hard-coded rates in code) — see {@link TaxRuleParams}.
   */
  export interface TaxRuleRow {
    id: string;
    tenant_id: string | null;
    jurisdiction: string;
    rule_type: TaxRuleType;
    effective_from: string;
    effective_to: string | null;
    params: TaxRuleParams;
    version: number;
  }

  /**
   * Statutory math expressed as data. A rule is either a flat rate or a set of progressive brackets:
   *  - `rate` — a flat fraction of the taxable base (e.g. `0.2` = 20%).
   *  - `brackets` — progressive marginal bands; each band taxes the slice of base in
   *    `(prevUpTo, upTo]` at `rate`. The final band may omit `up_to` (open-ended top band).
   * All money is integer minor units; bracket bounds are minor units too.
   */
  export interface TaxRuleParams {
    rate?: number;
    brackets?: TaxBracket[];
  }

  /** One progressive marginal band. `up_to` (minor units) is the band ceiling; omit it for the top band. */
  export interface TaxBracket {
    up_to?: number | null;
    rate: number;
  }

  /** A row of the `payments` table (idempotent disbursement per payslip). */
  export interface PaymentRow {
    id: string;
    tenant_id: string;
    payslip_id: string;
    batch_id: string | null;
    amount: number;
    currency: string;
    status: string;
    idempotency_key: string;
    rail_ref: string | null;
  }

  /** A row of the `ledger_entries` table (append-only double-entry GL). */
  export interface LedgerEntryRow {
    id: string;
    tenant_id: string;
    pay_run_id: string;
    account: string;
    debit: number;
    credit: number;
    currency: string;
    reversal_of: string | null;
  }

  // ---- Repository write inputs ----

  /** Input to create an `employees` row (PII columns arrive already encrypted). */
  export interface CreateEmployeeRow {
    tenant_id: string;
    user_id?: string | null;
    person_ref?: string | null;
    work_jurisdiction: string;
    residence_jurisdiction?: string | null;
    employment_status?: string;
    bank_account_enc: string | null;
    national_id_enc: string | null;
  }

  /** Input to create a `pay_runs` row (always seeded in the Draft state). */
  export interface CreatePayRunRow {
    tenant_id: string;
    pay_calendar_id?: string | null;
    period_start: string;
    period_end: string;
    pay_date: string;
    type: string;
    status: string;
    created_by: string;
  }

  /** Filter for `PayRunRepository.listPayRuns` / `PayRunService.list`. */
  export interface PayRunListFilter {
    statuses?: string[];
    tagIds?: string[];
    tagIncludeNone?: boolean;
    tagMatch?: 'any' | 'all' | 'none';
    teamIds?: string[];
    teamIncludeNone?: boolean;
    assigneeIds?: string[];
    assigneeIncludeNone?: boolean;
  }

  /** Input to create a `payslips` row (a per-employee shell; totals computed at calculate). */
  export interface CreatePayslipRow {
    tenant_id: string;
    pay_run_id: string;
    employee_id: string;
    gross: number;
    taxable_base: number;
    total_tax: number;
    total_deductions: number;
    net_enc: string | null;
    currency: string;
    status: string;
  }

  /** Patch applied to a `payslips` row when a pay-run is calculated. */
  export interface UpdatePayslipTotalsRow {
    gross: number;
    taxable_base: number;
    total_tax: number;
    total_deductions: number;
    net_enc: string | null;
    /** Currency resolved from the employee's effective contract at calculate (W5-09). */
    currency?: string;
    status: string;
  }

  /** Input to create a `payments` row (idempotent per `idempotency_key`). */
  export interface CreatePaymentRow {
    tenant_id: string;
    payslip_id: string;
    batch_id: string | null;
    amount: number;
    currency: string;
    status: string;
    idempotency_key: string;
  }

  /** Input to create a `payment_batches` row. */
  export interface CreatePaymentBatchRow {
    tenant_id: string;
    pay_run_id: string;
    status: string;
  }

  /** Input to append a `ledger_entries` row (append-only; corrections post a reversal). */
  export interface AppendLedgerEntryRow {
    tenant_id: string;
    pay_run_id: string;
    account: string;
    debit: number;
    credit: number;
    currency: string;
    reversal_of?: string | null;
  }

  // ---- Service inputs (the public method args) ----

  /** Args to `EmployeeService.create`. */
  export interface CreateEmployeeInput {
    /** Optional identity user this employee record belongs to. Required for own-payslip access. */
    userId?: string;
    workJurisdiction: string;
    residenceJurisdiction?: string;
    personRef?: string;
    employmentStatus?: string;
    bankAccount?: string;
    nationalId?: string;
  }

  /** Args to `PayRunService.create`. */
  export interface CreatePayRunInput {
    periodStart: string;
    periodEnd: string;
    payDate: string;
    type?: PayRunType;
    payCalendarId?: string;
    employeeIds?: string[];
  }

  // ---- Service result DTOs (the explicit response shapes) ----

  /** Result of the employee surface — sensitive PII is masked unless the obligation is granted. */
  export interface EmployeeDto {
    id: string;
    userId: string | null;
    employmentStatus: string;
    workJurisdiction: string;
    residenceJurisdiction: string | null;
    bankAccount: string | null;
    nationalId: string | null;
  }

  /** Result of the pay-run surface — the run header projection (no net pay, no PII). */
  export interface PayRunDto {
    id: string;
    status: string;
    type: string;
    periodStart: string;
    periodEnd: string;
    payDate: string;
    createdBy: string;
    approvedBy: string | null;
    teamId: string | null;
    assigneeId: string | null;
    tags: string[];
  }

  /** Non-sensitive payslip projection. Never exposes `net_enc` or clear net pay. */
  export interface PayslipDto {
    id: string;
    payRunId: string;
    employeeId: string;
    gross: number;
    taxableBase: number;
    totalTax: number;
    totalDeductions: number;
    currency: string;
    status: string;
  }

  /** Result of `PayRunService.list` — the standard `{ data, meta }` page shape. */
  export interface PayRunListResult {
    data: PayRunDto[];
    meta: { total: number; page: number; pageSize: number };
  }

  /** Filters for tenant-scoped payslip list/detail APIs. */
  export interface PayslipListFilter {
    payRunId?: string;
    employeeId?: string;
    status?: PayslipStatus;
    /** Internal-only filter: restrict payslips to employees bound to this authenticated user. */
    userId?: string;
  }

  /** Result of `PayRunService.listPayslips` — the standard `{ data, meta }` page shape. */
  export interface PayslipListResult {
    data: PayslipDto[];
    meta: { total: number; page: number; pageSize: number };
  }

  /**
   * Args to `PayRunService.decide` — one approver's terminal decision on a CALCULATED pay run,
   * routed through the shared `@aegis/approvals` engine. `comment` is recorded on the immutable vote.
   */
  export interface DecidePayRunInput {
    decision: 'approved' | 'rejected';
    comment?: string;
  }

  /** One PENDING pay-run approval slot the current user owns, hydrated with its run header. */
  export interface PendingPayRunApprovalDto {
    payRunId: string;
    /** The chain level this slot sits at. */
    level: number;
    payRun: PayRunDto;
  }

  /** A header-level account → {debit, credit} GL summary for a pay-run (pushed to ERP connectors). */
  export type GlSummary = Record<string, { debit: number; credit: number }>;

  /** The result of computing one employee's payslip totals (all minor units). */
  export interface PayslipComputation {
    gross: number;
    taxableBase: number;
    totalTax: number;
    totalDeductions: number;
    net: number;
  }
}
