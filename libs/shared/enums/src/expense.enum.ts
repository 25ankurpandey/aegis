/** Expense report lifecycle. See docs/services/expense.md. */
export enum ExpenseReportStatus {
  Open = 'open',
  Approvals = 'approvals',
  Approved = 'approved',
  Rejected = 'rejected',
  Reimbursed = 'reimbursed',
}

export const ExpenseReportStatusDisplay: Record<ExpenseReportStatus, string> = {
  [ExpenseReportStatus.Open]: 'Open',
  [ExpenseReportStatus.Approvals]: 'In Approvals',
  [ExpenseReportStatus.Approved]: 'Approved',
  [ExpenseReportStatus.Rejected]: 'Rejected',
  [ExpenseReportStatus.Reimbursed]: 'Reimbursed',
};

/** A report is only editable while Open. */
export const EDITABLE_EXPENSE_STATUSES: readonly ExpenseReportStatus[] = [ExpenseReportStatus.Open];

export enum ExpenseActivityType {
  ReportCreated = 'report_created',
  ReportSubmitted = 'report_submitted',
  ReportApproved = 'report_approved',
  ReportRejected = 'report_rejected',
  ReportReimbursed = 'report_reimbursed',
  ReportRecalled = 'report_recalled',
  CommentAdded = 'comment_added',
}
