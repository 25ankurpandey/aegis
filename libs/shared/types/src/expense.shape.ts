import type { ExpenseReportStatus } from '@aegis/shared-enums';

/**
 * Domain contract for the expense service (the expense-report state machine + item management).
 * Service-local DTOs, repository row shapes, repository write inputs, and the service method args
 * all live here (SPEC §11.2 — no domain types defined inside the service). Controllers and services
 * import these from `@aegis/shared-types`; nothing expense-domain-typed is declared locally.
 */
export namespace ExpenseShape {
  // ---- Persistence row shapes (what repositories return; `*.get({ plain: true })`) ----

  /** A row of the `expense_reports` table (money columns are BIGINT integer minor units → string). */
  export interface ExpenseReportRow {
    id: string;
    tenant_id: string;
    report_number: string;
    name: string;
    status: string;
    submitter_id: string;
    total_amount: string;
    currency: string;
    /** Owning team set by a workflow `assign_team` rule action (via the RecordUpdated follow-on). */
    team_id?: string | null;
    /** Current assignee/owner set by a workflow/manual assignment (via the RecordUpdated follow-on). */
    assignee_id?: string | null;
    /** Classification tags attached by a workflow `add_tag` rule action (unioned, distinct). */
    tags?: string[] | null;
    submitted_at: Date | null;
    synced_at: Date | null;
  }

  /** A row of the `expenses` table (a single expense item, optionally attached to a report). */
  export interface ExpenseRow {
    id: string;
    tenant_id: string;
    report_id: string | null;
    category_id: string | null;
    amount: string;
    currency: string;
    merchant: string | null;
    incurred_on: string | null;
    description: string | null;
    receipt_ref: string | null;
    created_by: string;
    assigned_to_report_at: Date | null;
  }

  /** A row of the `expense_categories` table. */
  export interface ExpenseCategoryRow {
    id: string;
    tenant_id: string;
    name: string;
    code: string | null;
    is_active: boolean;
  }

  /** A row of the `expense_approvals` table (one approval decision in the chain). */
  export interface ExpenseApprovalRow {
    id: string;
    tenant_id: string;
    report_id: string;
    approver_id: string;
    decision: string;
    level: number;
    comment: string | null;
    decided_at: Date;
  }

  /** A row of the `expense_comments` table. */
  export interface ExpenseCommentRow {
    id: string;
    tenant_id: string;
    report_id: string;
    user_id: string;
    body: string;
    created_at?: Date | null;
  }

  /** A row of the `expense_activities` table (append-only audit feed). */
  export interface ExpenseActivityRow {
    id: string;
    tenant_id: string;
    report_id: string;
    user_id: string | null;
    activity_type: string;
    details: Record<string, unknown> | null;
    created_at?: Date | null;
  }

  // ---- Repository write inputs ----

  /** Input to create an `expense_reports` row. */
  export interface CreateReportRow {
    tenant_id: string;
    report_number: number;
    name: string;
    status: string;
    submitter_id: string;
    currency: string;
  }

  /** Patch applied to an `expense_reports` row. */
  export interface UpdateReportRow {
    status?: string;
    total_amount?: number;
    submitted_at?: Date;
    synced_at?: Date;
    team_id?: string | null;
    assignee_id?: string | null;
    tags?: string[] | null;
  }

  /** Options for paging/scoping the report list. */
  export interface ListReportsOptions {
    submitterId?: string;
    tagIds?: string[];
    tagIncludeNone?: boolean;
    tagMatch?: 'any' | 'all' | 'none';
    teamIds?: string[];
    teamIncludeNone?: boolean;
    assigneeIds?: string[];
    assigneeIncludeNone?: boolean;
    statuses?: string[];
    limit: number;
    offset: number;
  }

  /** Input to create an `expenses` row. */
  export interface CreateExpenseRow {
    tenant_id: string;
    report_id: string | null;
    category_id: string | null;
    amount: number;
    currency: string;
    merchant?: string;
    incurred_on?: string;
    description?: string;
    receipt_ref?: string;
    created_by: string;
  }

  /** Input to create an `expense_approvals` row. */
  export interface CreateApprovalRow {
    tenant_id: string;
    report_id: string;
    approver_id: string;
    decision: string;
    level: number;
    comment?: string;
  }

  /** Input to create an `expense_comments` row. */
  export interface CreateCommentRow {
    tenant_id: string;
    report_id: string;
    user_id: string;
    body: string;
  }

  /** Input to create an `expense_activities` row. */
  export interface CreateActivityRow {
    tenant_id: string;
    report_id: string;
    user_id: string | null;
    activity_type: string;
    details?: Record<string, unknown>;
  }

  // ---- Service inputs (the public method args) ----

  /** Args to `ExpenseService.createExpense` / `attachExpenseToReport`. */
  export interface CreateExpenseInput {
    amount: number;
    currency?: string;
    merchant?: string;
    incurredOn?: string;
    description?: string;
    categoryId?: string;
    receiptRef?: string;
    reportId?: string;
  }

  /** Args to `ExpenseService.createReport`. */
  export interface CreateReportInput {
    name: string;
    currency?: string;
  }

  /** Body of the legacy `POST /reports/:id/approve` alias (routes to the engine-backed `decideReport`). */
  export interface ApproveInput {
    comment?: string;
  }

  /** Args to `ExpenseService.rejectReport`. */
  export interface RejectInput {
    reason?: string;
    comment?: string;
  }

  /**
   * Args to `ExpenseService.decideReport` — one approver's decision on a report, routed through the
   * shared approval engine. `decision` is the engine's terminal vote; `comment` is recorded on the
   * vote ledger + the report's decision row.
   */
  export interface DecideInput {
    decision: 'approved' | 'rejected';
    comment?: string;
  }

  /** Args to `ExpenseService.reimburseReport`. */
  export interface ReimburseInput {
    comment?: string;
  }

  /** Args to `ExpenseService.listReports`. */
  export interface ListReportsInput {
    page: number;
    pageSize: number;
    tagIds?: string[];
    tagIncludeNone?: boolean;
    tagMatch?: 'any' | 'all' | 'none';
    teamIds?: string[];
    teamIncludeNone?: boolean;
    assigneeIds?: string[];
    assigneeIncludeNone?: boolean;
    statuses?: string[];
  }

  /** Args to `ExpenseService.addComment`. */
  export interface AddCommentInput {
    body: string;
  }

  /** Args to `ExpenseService.recallReport`. */
  export interface RecallInput {
    reason?: string;
    comment?: string;
  }

  // ---- Service result DTOs (the explicit response shapes) ----

  /** Result of the report read/write surface — money is a JS number of integer minor units. */
  export interface ExpenseReportDto {
    id: string;
    reportNumber: number;
    name: string;
    status: ExpenseReportStatus;
    submitterId: string;
    teamId: string | null;
    assigneeId: string | null;
    tags: string[];
    totalAmount: number;
    currency: string;
    submittedAt: string | null;
    syncedAt: string | null;
  }

  /** Result of the expense-item write surface. */
  export interface ExpenseDto {
    id: string;
    reportId: string | null;
    categoryId: string | null;
    amount: number;
    currency: string;
    merchant: string | null;
    incurredOn: string | null;
    description: string | null;
    receiptRef: string | null;
    createdBy: string;
  }

  /** Result of `ExpenseService.listReports` — the standard `{ data, meta }` page shape. */
  export interface ListReportsResult {
    data: ExpenseReportDto[];
    meta: { total: number; page: number; pageSize: number };
  }

  /** One approval decision in the report detail (mapped from `expense_approvals`). */
  export interface ApprovalDto {
    id: string;
    approverId: string;
    decision: string;
    level: number;
    comment: string | null;
    decidedAt: string;
  }

  /** One comment in the report detail / comment list (mapped from `expense_comments`). */
  export interface CommentDto {
    id: string;
    reportId: string;
    userId: string;
    body: string;
    createdAt: string | null;
  }

  /** One entry in the report activity timeline (mapped from `expense_activities`). */
  export interface ActivityDto {
    id: string;
    userId: string | null;
    activityType: string;
    details: Record<string, unknown> | null;
    createdAt: string | null;
  }

  /**
   * One row of an approver's pending expense-report inbox (`ExpenseService.listPendingApprovals`):
   * the report awaiting THIS user's decision, plus the chain level their slot sits at.
   */
  export interface PendingApprovalDto {
    reportId: string;
    level: number;
    report: ExpenseReportDto;
  }

  /**
   * The full expense-report detail returned by `ExpenseService.getReportDetail` (W3-13a):
   * the report header + its line expenses + the approval chain + comments + the activity timeline,
   * assembled in one tenant-scoped (RLS) read.
   */
  export interface ExpenseReportDetailDto {
    report: ExpenseReportDto;
    expenses: ExpenseDto[];
    approvals: ApprovalDto[];
    comments: CommentDto[];
    activities: ActivityDto[];
  }
}
