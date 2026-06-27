import type { ModelStatic, Model, Sequelize } from 'sequelize';
import { getSequelize, createModelRegistry } from '@aegis/db';
import { defineEmployee } from './employee.model';
import { defineEmploymentContract } from './employment-contract.model';
import { definePayCalendar } from './pay-calendar.model';
import { defineEarningCode } from './earning-code.model';
import { defineDeductionCode } from './deduction-code.model';
import { defineTaxRule } from './tax-rule.model';
import { defineEmployeePayItem } from './employee-pay-item.model';
import { definePayRun } from './pay-run.model';
import { definePayslip } from './payslip.model';
import { definePayslipLine } from './payslip-line.model';
import { definePayrollInputItem } from './payroll-input-item.model';
import { definePaymentBatch } from './payment-batch.model';
import { definePayment } from './payment.model';
import { defineLedgerEntry } from './ledger-entry.model';

type M = ModelStatic<Model>;

/** The set of payroll models, registered on the shared connection (the service's DatabaseContext). */
export interface PayrollContext {
  Employee: M;
  EmploymentContract: M;
  PayCalendar: M;
  EarningCode: M;
  DeductionCode: M;
  TaxRule: M;
  EmployeePayItem: M;
  PayRun: M;
  Payslip: M;
  PayslipLine: M;
  PayrollInputItem: M;
  Payment: M;
  PaymentBatch: M;
  LedgerEntry: M;
  sequelize: Sequelize;
}

let ctx: PayrollContext | null = null;

/**
 * Defines every payroll model on the shared (non-owner, RLS-enforced) `getSequelize()` connection
 * (once), wires the associations, and returns the assembled context. The return shape is unchanged
 * from the previous single-file `context.ts`, so all callers keep working (SPEC §11.1 — one
 * `*.model.ts` per table + a `database-context.ts` that imports + registers them).
 */
export function getPayrollContext(): PayrollContext {
  if (ctx) return ctx;
  const s = getSequelize();
  // Single registration path through the registry (W2-09).
  const registry = createModelRegistry(s);

  const Employee = registry.register(defineEmployee(s));
  const EmploymentContract = registry.register(defineEmploymentContract(s));
  const PayCalendar = registry.register(definePayCalendar(s));
  const EarningCode = registry.register(defineEarningCode(s));
  const DeductionCode = registry.register(defineDeductionCode(s));
  const TaxRule = registry.register(defineTaxRule(s));
  const EmployeePayItem = registry.register(defineEmployeePayItem(s));
  const PayRun = registry.register(definePayRun(s));
  const Payslip = registry.register(definePayslip(s));
  const PayslipLine = registry.register(definePayslipLine(s));
  const PayrollInputItem = registry.register(definePayrollInputItem(s));
  const PaymentBatch = registry.register(definePaymentBatch(s));
  const Payment = registry.register(definePayment(s));
  const LedgerEntry = registry.register(defineLedgerEntry(s));

  Employee.hasMany(EmploymentContract, { foreignKey: 'employee_id', as: 'contracts' });
  Employee.hasMany(EmployeePayItem, { foreignKey: 'employee_id', as: 'payItems' });
  PayRun.hasMany(Payslip, { foreignKey: 'pay_run_id', as: 'payslips' });
  Payslip.hasMany(PayslipLine, { foreignKey: 'payslip_id', as: 'lines' });
  Payslip.hasOne(Payment, { foreignKey: 'payslip_id', as: 'payment' });
  PayRun.hasMany(LedgerEntry, { foreignKey: 'pay_run_id', as: 'ledgerEntries' });

  ctx = {
    Employee, EmploymentContract, PayCalendar, EarningCode, DeductionCode, TaxRule,
    EmployeePayItem, PayRun, Payslip, PayslipLine, PayrollInputItem, Payment,
    PaymentBatch, LedgerEntry, sequelize: s,
  };
  return ctx;
}
