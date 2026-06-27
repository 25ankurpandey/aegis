import { ExpenseReportStatus } from '@aegis/shared-enums';

/**
 * Role-keyed status transition maps for the expense-report lifecycle
 * OPEN → APPROVALS → APPROVED / REJECTED → REIMBURSED.
 * The map chosen is keyed by the principal's effective role for the report (submitter /
 * manager-of-submitter / finance). `admin` may take any structurally valid edge but still
 * passes the PDP and emits audit. See docs/services/expense.md §5.
 */
export class ExpenseReportTransitions {
  /** The submitter advances their own report and can pull it back. */
  static readonly SUBMITTER: Partial<Record<ExpenseReportStatus, ExpenseReportStatus[]>> = {
    [ExpenseReportStatus.Open]: [ExpenseReportStatus.Approvals], // submit
    [ExpenseReportStatus.Approvals]: [ExpenseReportStatus.Open], // recall
    [ExpenseReportStatus.Rejected]: [ExpenseReportStatus.Open], // revise & resubmit
  };

  /** The manager decides on a report that is in the approval chain. */
  static readonly MANAGER: Partial<Record<ExpenseReportStatus, ExpenseReportStatus[]>> = {
    [ExpenseReportStatus.Approvals]: [ExpenseReportStatus.Approved, ExpenseReportStatus.Rejected],
  };

  /** Finance/admin records reimbursement after approval. */
  static readonly FINANCE: Partial<Record<ExpenseReportStatus, ExpenseReportStatus[]>> = {
    [ExpenseReportStatus.Approved]: [ExpenseReportStatus.Reimbursed],
  };
}

/** Decision values written into expense_approvals.decision. */
export class ExpenseDecision {
  static readonly Approved = 'approved';
  static readonly Rejected = 'rejected';
}
