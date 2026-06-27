/** Payroll enums. See docs/services/payroll.md. */
export enum PayRunStatus {
  Draft = 'draft',
  Calculated = 'calculated',
  Approved = 'approved',
  Funding = 'funding',
  Paid = 'paid',
  Reversed = 'reversed',
}

export enum PayRunType {
  Regular = 'regular',
  OffCycle = 'off_cycle',
}

export enum PayItemKind {
  Earning = 'earning',
  Deduction = 'deduction',
  Tax = 'tax',
  EmployerContribution = 'employer_contribution',
}

export enum PayItemSource {
  Base = 'base',
  Recurring = 'recurring',
  Expense = 'expense',
  Bonus = 'bonus',
  Adjustment = 'adjustment',
}

/**
 * Where a single payslip line originated. A superset of {@link PayItemSource} (base / recurring /
 * expense / bonus / adjustment) plus `tax`: a payslip line can be a computed tax line, which is NOT
 * a valid source for an authored pay item. Kept distinct from {@link PayItemSource} so neither
 * value-set silently acquires the other's members. Pins `payslip_lines.source`.
 */
export enum PayslipLineSource {
  Base = 'base',
  Recurring = 'recurring',
  Expense = 'expense',
  Bonus = 'bonus',
  Adjustment = 'adjustment',
  Tax = 'tax',
}

/** Employee lifecycle. Pins `employees.employment_status` (default `active`). */
export enum EmploymentStatus {
  Active = 'active',
  OnLeave = 'on_leave',
  Suspended = 'suspended',
  Terminated = 'terminated',
}

/** Employment-contract kind. Pins `employment_contracts.type` (default `salaried`). */
export enum ContractType {
  Salaried = 'salaried',
  Hourly = 'hourly',
  Contractor = 'contractor',
}

/**
 * Pay-run / pay-item cadence. Pins `pay_calendars.frequency`,
 * `employment_contracts.pay_frequency`, and `employee_pay_items.frequency` (default `monthly`).
 */
export enum PayFrequency {
  Weekly = 'weekly',
  Biweekly = 'biweekly',
  Semimonthly = 'semimonthly',
  Monthly = 'monthly',
  Quarterly = 'quarterly',
  Annual = 'annual',
  OneTime = 'one_time',
}

/**
 * Payslip lifecycle. Distinct from {@link PayRunStatus} (which has a `funding` state) — a payslip
 * has no funding state. Pins `payslips.status` (default `draft`).
 */
export enum PayslipStatus {
  Draft = 'draft',
  Calculated = 'calculated',
  Approved = 'approved',
  Paid = 'paid',
  Reversed = 'reversed',
}

/** Payroll-input settlement timing. Pins the payroll-input `settlement` column (default `cyclic`). */
export enum SettlementMode {
  Cyclic = 'cyclic',
  Immediate = 'immediate',
  OffCycle = 'off_cycle',
}

/** Tax-rule taxonomy. Pins `tax_rules.rule_type`. */
export enum TaxRuleType {
  IncomeTax = 'income_tax',
  SocialSecurity = 'social_security',
  Medicare = 'medicare',
  Unemployment = 'unemployment',
  Flat = 'flat',
  Bracket = 'bracket',
}

export enum PaymentStatus {
  Pending = 'pending',
  Submitted = 'submitted',
  Settled = 'settled',
  Failed = 'failed',
  Returned = 'returned',
}

export enum PayrollInputStatus {
  Pending = 'pending',
  Consumed = 'consumed',
}

export enum LedgerAccount {
  WageExpense = 'wage_expense',
  EmployerTaxExpense = 'employer_tax_expense',
  Cash = 'cash',
  TaxLiability = 'tax_liability',
  DeductionLiability = 'deduction_liability',
}
