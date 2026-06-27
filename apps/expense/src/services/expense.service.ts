import { inject } from 'inversify';
import type { Transaction } from 'sequelize';
import { ErrUtils, FeatureFlags, RequestContext } from '@aegis/service-core';
import {
  RecordAnnotationFeatureFlag,
  attachRecordTags,
  detachRecordTags,
  withTenantTransaction,
} from '@aegis/db';
import {
  ExpenseReportStatus,
  ExpenseActivityType,
  ConnectorKind,
  ConnectorEntity,
  SystemRole,
  AuditAction,
  AuditOutcome,
  ApprovalRecordType,
  ApprovalDecision,
} from '@aegis/shared-enums';
import { makeEnvelope, stageOutboxEvent, EventTopic, type PayloadOf } from '@aegis/events';
import { AuditLogger } from '@aegis/audit';
import { ActivityLogger } from '@aegis/activity';
import { ApprovalService } from '@aegis/approvals';
import { ExpenseShape, type ApprovalShape } from '@aegis/shared-types';
import { ExpenseReportTransitions, ExpenseDecision } from '@aegis/shared-constants';
import { provideSingleton } from '../ioc/container';
import { ExpenseReportRepository } from '../repositories/expense-report.repository';
import { ExpenseRepository } from '../repositories/expense.repository';

/**
 * Compute the minimal label patch for a workflow `assign_team` / `add_tag` action: SET the owning team
 * (only when it differs) and UNION the new tags onto the existing set (distinct, preserving order).
 * Returns `null` when nothing changes, so the caller can no-op idempotently on an at-least-once
 * redelivery. Pure (no IO) — the per-service consumers all share this exact merge semantics.
 */
function computeLabelPatch(
  row: { team_id?: string | null; assignee_id?: string | null; tags?: string[] | null },
  update: {
    teamId?: string | null;
    assigneeId?: string | null;
    tags?: string[];
    removeTags?: string[];
    replaceTags?: boolean;
  },
): {
  write: { team_id?: string | null; assignee_id?: string | null; tags?: string[] | null };
  added: string[];
  removed: string[];
} | null {
  const write: { team_id?: string | null; assignee_id?: string | null; tags?: string[] | null } =
    {};
  let changed = false;

  if (update.teamId !== undefined && update.teamId !== row.team_id) {
    write.team_id = update.teamId;
    changed = true;
  }

  if (update.assigneeId !== undefined && update.assigneeId !== row.assignee_id) {
    write.assignee_id = update.assigneeId;
    changed = true;
  }

  let added: string[] = [];
  let removed: string[] = [];
  const existing = Array.isArray(row.tags) ? row.tags : [];
  if (update.replaceTags && update.tags) {
    const next = unique(update.tags);
    added = next.filter((tag) => !existing.includes(tag));
    removed = existing.filter((tag) => !next.includes(tag));
    if (added.length > 0 || removed.length > 0) {
      write.tags = next;
      changed = true;
    }
  } else {
    let next = [...existing];
    if (update.tags && update.tags.length > 0) {
      added = update.tags.filter((tag) => !next.includes(tag));
      if (added.length > 0) next = [...next, ...added];
    }
    if (update.removeTags && update.removeTags.length > 0) {
      removed = next.filter((tag) => update.removeTags?.includes(tag));
      next = next.filter((tag) => !update.removeTags?.includes(tag));
    }
    if (added.length > 0 || removed.length > 0) {
      write.tags = next;
      changed = true;
    }
  }

  return changed ? { write, added, removed } : null;
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Expense-report state machine + item management. Every tenant-scoped read/write runs inside
 * withTenantTransaction (RLS: SET LOCAL app.current_tenant). Transitions are keyed by the
 * principal's effective role for the report (submitter / manager / finance / admin), each checked
 * against the role-keyed transition maps. Writes also append an expense_activities row; approvals
 * emit domain events and stage ERP pushes through the transactional outbox.
 */
@provideSingleton(ExpenseService)
export class ExpenseService {
  constructor(
    @inject(ExpenseReportRepository) private readonly reports: ExpenseReportRepository,
    @inject(ExpenseRepository) private readonly expenses: ExpenseRepository,
    // The shared multi-level approval engine, injected via the reusable `registerApprovalProviders()`
    // wiring in `ioc/loader.ts` (the template invoice/payroll copy). Tenant-scoped internally.
    @inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  // ---- expenses (items) ----

  /** Add a standalone expense item (optionally already attached to a report). */
  async createExpense(input: ExpenseShape.CreateExpenseInput): Promise<ExpenseShape.ExpenseDto> {
    const tenantId = RequestContext.tenantId();
    const userId = this.requireUser();
    return withTenantTransaction(async (t) => {
      let reportId: string | null = null;
      let itemCurrency = input.currency ?? 'USD';
      if (input.reportId) {
        const report = await this.reports.findReportById(input.reportId, t);
        if (!report) throw ErrUtils.notFound('Expense report not found');
        this.assertEditable(report);
        reportId = report.id;
        // Attaching at creation time must respect the report's single-currency total invariant.
        itemCurrency = input.currency ?? report.currency;
        this.assertItemCurrencyMatches(itemCurrency, report.currency);
      }
      const row = await this.expenses.createExpense(
        {
          tenant_id: tenantId,
          report_id: reportId,
          category_id: input.categoryId ?? null,
          amount: input.amount,
          currency: itemCurrency,
          merchant: input.merchant,
          incurred_on: input.incurredOn,
          description: input.description,
          receipt_ref: input.receiptRef,
          created_by: userId,
        },
        t,
      );
      if (reportId) await this.reports.recomputeReportTotal(reportId, t);
      return this.toExpenseDto(row);
    });
  }

  /** Read one expense item (404 if RLS-invisible). */
  async getExpense(id: string): Promise<ExpenseShape.ExpenseDto> {
    return withTenantTransaction(async (t) => {
      const row = await this.expenses.findExpenseById(id, t);
      if (!row) throw ErrUtils.notFound('Expense not found');
      return this.toExpenseDto(row);
    });
  }

  // ---- reports ----

  /** Create a new report in OPEN status with the next per-tenant report number. */
  async createReport(
    input: ExpenseShape.CreateReportInput,
  ): Promise<ExpenseShape.ExpenseReportDto> {
    const tenantId = RequestContext.tenantId();
    const userId = this.requireUser();
    return withTenantTransaction(async (t) => {
      const reportNumber = await this.reports.nextReportNumber(t);
      const row = await this.reports.createReport(
        {
          tenant_id: tenantId,
          report_number: reportNumber,
          name: input.name,
          status: ExpenseReportStatus.Open,
          submitter_id: userId,
          currency: input.currency ?? 'USD',
        },
        t,
      );
      await this.writeActivity(
        row.id,
        userId,
        ExpenseActivityType.ReportCreated,
        { name: row.name },
        t,
      );
      await this.publish(
        EventTopic.ExpenseSubmitted,
        {
          reportId: row.id,
          status: row.status,
          submitterId: row.submitter_id,
          event: 'created',
        },
        t,
      );
      return this.toReportDto(row);
    });
  }

  async getReport(id: string): Promise<ExpenseShape.ExpenseReportDto> {
    return withTenantTransaction(async (t) => {
      const row = await this.reports.findReportById(id, t);
      if (!row) throw ErrUtils.notFound('Expense report not found');
      return this.toReportDto(row);
    });
  }

  /**
   * W3-13a — the full report detail in ONE tenant-scoped (RLS) read: the header, its line expenses,
   * the approval chain, the comment thread, and the activity timeline. Guarded by the same view
   * permission as `getReport`; a report invisible under RLS yields the standard 404.
   */
  async getReportDetail(id: string): Promise<ExpenseShape.ExpenseReportDetailDto> {
    return withTenantTransaction(async (t) => {
      const report = await this.reports.findReportById(id, t);
      if (!report) throw ErrUtils.notFound('Expense report not found');
      const [expenses, approvals, comments, activities] = await Promise.all([
        this.expenses.listExpensesForReport(id, t),
        this.reports.listApprovalsForReport(id, t),
        this.reports.listCommentsForReport(id, t),
        this.reports.listActivitiesForReport(id, t),
      ]);
      return {
        report: this.toReportDto(report),
        expenses: expenses.map((e) => this.toExpenseDto(e)),
        approvals: approvals.map((a) => this.toApprovalDto(a)),
        comments: comments.map((c) => this.toCommentDto(c)),
        activities: activities.map((a) => this.toActivityDto(a)),
      };
    });
  }

  // ---- comments (W3-13b) ----

  /**
   * Add a free-text comment to a report's discussion thread. Guarded by the view permission (anyone
   * who can see the report may comment on it). Also appends a CommentAdded activity so the timeline
   * reflects the discussion. 404 if the report is RLS-invisible.
   */
  async addComment(
    reportId: string,
    input: ExpenseShape.AddCommentInput,
  ): Promise<ExpenseShape.CommentDto> {
    const tenantId = RequestContext.tenantId();
    const userId = this.requireUser();
    return withTenantTransaction(async (t) => {
      const report = await this.reports.findReportById(reportId, t);
      if (!report) throw ErrUtils.notFound('Expense report not found');
      const row = await this.reports.createComment(
        { tenant_id: tenantId, report_id: reportId, user_id: userId, body: input.body },
        t,
      );
      await this.writeActivity(
        reportId,
        userId,
        ExpenseActivityType.CommentAdded,
        { commentId: row.id },
        t,
      );
      return this.toCommentDto(row);
    });
  }

  /** List a report's comment thread (oldest first). Guarded by the view permission. */
  async listComments(reportId: string): Promise<ExpenseShape.CommentDto[]> {
    return withTenantTransaction(async (t) => {
      const report = await this.reports.findReportById(reportId, t);
      if (!report) throw ErrUtils.notFound('Expense report not found');
      const rows = await this.reports.listCommentsForReport(reportId, t);
      return rows.map((c) => this.toCommentDto(c));
    });
  }

  /**
   * W3-13c — RECALL: the submitter pulls a still-pending report back out of the approval chain
   * (APPROVALS → OPEN) so they can revise it, mirroring submit/reject. Submitter-only (admin may
   * also act); rejected if the report is already APPROVED/REIMBURSED (the SUBMITTER transition map
   * only permits APPROVALS → OPEN). Writes a ReportRecalled activity + an audit state-transition.
   * No event/ERP push — a recalled report never reached the ledger.
   */
  async recallReport(
    reportId: string,
    input: ExpenseShape.RecallInput,
  ): Promise<ExpenseShape.ExpenseReportDto> {
    const userId = this.requireUser();
    const reason = input.reason ?? input.comment;
    return withTenantTransaction(async (t) => {
      const report = await this.reports.findReportById(reportId, t);
      if (!report) throw ErrUtils.notFound('Expense report not found');

      this.assertTransition(report, ExpenseReportStatus.Open, 'submitter');

      const updated = (await this.reports.updateReport(
        reportId,
        { status: ExpenseReportStatus.Open },
        t,
      )) as ExpenseShape.ExpenseReportRow;

      await this.writeActivity(
        reportId,
        userId,
        ExpenseActivityType.ReportRecalled,
        { from: report.status, to: ExpenseReportStatus.Open, reason },
        t,
      );

      await AuditLogger.record(
        {
          action: AuditAction.StateTransition,
          outcome: AuditOutcome.Success,
          resourceType: 'expense_report',
          resourceId: reportId,
          details: { to: ExpenseReportStatus.Open },
        },
        t,
      );

      return this.toReportDto(updated);
    });
  }

  async listReports(input: ExpenseShape.ListReportsInput): Promise<ExpenseShape.ListReportsResult> {
    return withTenantTransaction(async (t) => {
      const offset = (input.page - 1) * input.pageSize;
      const submitterId = this.rowScopeSubmitterFilter();
      const { rows, total } = await this.reports.listReports(
        { ...input, submitterId, limit: input.pageSize, offset },
        t,
      );
      return {
        data: rows.map((r) => this.toReportDto(r)),
        meta: { total, page: input.page, pageSize: input.pageSize },
      };
    });
  }

  /**
   * The current user's PENDING expense-report approval slots — their "approvals inbox". Asks the
   * shared engine for the live, still-pending `record_approvers` slots this principal owns for
   * `ApprovalRecordType.ExpenseReport`, then hydrates each with its report header (RLS-scoped) so the
   * caller gets actionable rows (report name / number / total / submitter), not bare slot ids.
   */
  async listPendingApprovals(): Promise<ExpenseShape.PendingApprovalDto[]> {
    const userId = this.requireUser();
    const slots = await this.approvals.listPendingForApprover(
      userId,
      ApprovalRecordType.ExpenseReport,
    );
    if (slots.length === 0) return [];
    return withTenantTransaction(async (t) => {
      const out: ExpenseShape.PendingApprovalDto[] = [];
      for (const slot of slots) {
        const report = await this.reports.findReportById(slot.record_id, t);
        if (!report) continue; // RLS-invisible / deleted ⇒ drop from the inbox
        out.push({
          reportId: report.id,
          level: slot.level,
          report: this.toReportDto(report),
        });
      }
      return out;
    });
  }

  /** Attach an existing (or new) expense item to a report; only the submitter on an OPEN report. */
  async attachExpenseToReport(
    reportId: string,
    input: ExpenseShape.CreateExpenseInput,
  ): Promise<ExpenseShape.ExpenseReportDto> {
    const tenantId = RequestContext.tenantId();
    const userId = this.requireUser();
    return withTenantTransaction(async (t) => {
      const report = await this.reports.findReportById(reportId, t);
      if (!report) throw ErrUtils.notFound('Expense report not found');
      this.assertEditable(report);

      if (input.reportId && input.reportId !== reportId) {
        throw ErrUtils.validation('Mismatched reportId in body');
      }

      const existingId = (input as ExpenseShape.CreateExpenseInput & { expenseId?: string })
        .expenseId;
      if (existingId) {
        // A report's denormalized total is a single-currency sum (BIGINT minor units). Reject
        // attaching an item whose currency differs from the report's, rather than silently summing
        // across currencies and pushing a wrong total to the ERP (see recomputeReportTotal).
        const existing = await this.expenses.findExpenseById(existingId, t);
        if (!existing) throw ErrUtils.notFound('Expense not found');
        this.assertItemCurrencyMatches(existing.currency, report.currency);
        const attached = await this.expenses.attachExpenseToReport(existingId, reportId, t);
        if (!attached) throw ErrUtils.notFound('Expense not found');
      } else {
        // Inline-created items default to the report currency; an explicit mismatching currency
        // is rejected for the same single-currency-total invariant.
        const itemCurrency = input.currency ?? report.currency;
        this.assertItemCurrencyMatches(itemCurrency, report.currency);
        await this.expenses.createExpense(
          {
            tenant_id: tenantId,
            report_id: reportId,
            category_id: input.categoryId ?? null,
            amount: input.amount,
            currency: itemCurrency,
            merchant: input.merchant,
            incurred_on: input.incurredOn,
            description: input.description,
            receipt_ref: input.receiptRef,
            created_by: userId,
          },
          t,
        );
      }
      await this.reports.recomputeReportTotal(reportId, t);
      const updated = await this.reports.findReportById(reportId, t);
      return this.toReportDto(updated as ExpenseShape.ExpenseReportRow);
    });
  }

  /**
   * OPEN → APPROVALS, then hand the report to the shared approval engine.
   *
   * Submitter (or admin) only. Moves the report into its pending-approval status, records a
   * submitted activity (shared {@link ActivityLogger}) + ExpenseSubmitted, then calls
   * `ApprovalService.requestApproval` keyed by `(ExpenseReport, reportId)` with the report total +
   * currency + submitter, so the engine resolves the tenant's policy and materialises the approver
   * chain (and emits ApprovalRequested → notifications fan out). The engine call is idempotent, so a
   * re-submit never double-routes. If the resolved chain is EMPTY (no policy / SoD excluded everyone),
   * the engine auto-completes the chain as approved — we honour that immediately by advancing the
   * report straight to APPROVED (the same path `decideReport` takes on completion).
   */
  async submitReport(reportId: string): Promise<ExpenseShape.ExpenseReportDto> {
    const userId = this.requireUser();
    const submitted = await withTenantTransaction(async (t) => {
      const report = await this.reports.findReportById(reportId, t);
      if (!report) throw ErrUtils.notFound('Expense report not found');

      this.assertTransition(report, ExpenseReportStatus.Approvals, 'submitter');

      const updated = (await this.reports.updateReport(
        reportId,
        { status: ExpenseReportStatus.Approvals, submitted_at: new Date() },
        t,
      )) as ExpenseShape.ExpenseReportRow;

      await this.writeActivity(
        reportId,
        userId,
        ExpenseActivityType.ReportSubmitted,
        { from: report.status, to: ExpenseReportStatus.Approvals },
        t,
      );
      await this.publish(
        EventTopic.ExpenseSubmitted,
        {
          reportId,
          status: ExpenseReportStatus.Approvals,
          submitterId: report.submitter_id,
          totalAmount: Number(updated.total_amount),
          event: 'submitted',
        },
        t,
      );
      return updated;
    });

    // Materialise the approver chain via the shared engine (its own tenant tx). Idempotent: a
    // re-submit returns the existing chain rather than re-routing.
    const chain = await this.approvals.requestApproval({
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: reportId,
      // BUG-0007: pass the BIGINT minor-unit total straight through (the engine accepts bigint|string),
      // so amounts beyond Number.MAX_SAFE_INTEGER route to the correct threshold level. No Number().
      amountMinor: submitted.total_amount,
      currency: submitted.currency,
      requestedBy: submitted.submitter_id,
    });

    // Empty chain ⇒ the engine auto-completed (no required approvers). Advance straight to APPROVED
    // so the report never stalls in APPROVALS with nobody to act.
    if (chain.chain.length === 0) {
      return this.applyCompletion(reportId, 'approved', submitted.submitter_id);
    }

    return this.toReportDto(submitted);
  }

  /**
   * Record one approver's decision on a report through the shared approval engine, then advance the
   * report when the chain completes — the engine-backed replacement for the old single-shot
   * `approveReport`/`rejectReport`. Guarded by the expense `approve` permission at the controller.
   *
   * Flow: `ApprovalService.decide({ ExpenseReport, reportId, approverId, decision, comment })` appends
   * the immutable vote and advances/short-circuits the chain (the engine enforces no-double-vote and
   * that the principal is a PENDING approver — a non-approver gets a 403 from the engine). When the
   * chain reports COMPLETED we advance the expense_report status IN PROCESS here (approved→APPROVED,
   * rejected→REJECTED) via {@link applyCompletion}; until then the report stays in APPROVALS. The
   * status advance is idempotent (a report already in the terminal state is a no-op), so a replayed
   * ApprovalCompleted / a re-issued decide is again-safe and never needs a separate worker.
   */
  async decideReport(
    reportId: string,
    input: ExpenseShape.DecideInput,
  ): Promise<ExpenseShape.ExpenseReportDto> {
    const userId = this.requireUser();

    // Pre-flight: the report must exist (404) and be in APPROVALS (else the decision is moot). RLS
    // scopes the read; an invisible report yields the standard 404.
    const report = await withTenantTransaction((t) => this.reports.findReportById(reportId, t));
    if (!report) throw ErrUtils.notFound('Expense report not found');
    if (report.status !== ExpenseReportStatus.Approvals) {
      throw ErrUtils.conflict('Report is not awaiting approval');
    }

    // BUG-0005 SELF-HEAL: if the engine chain is ALREADY terminal but the report is still stranded in
    // APPROVALS (the in-request advance failed after the vote committed), don't try to re-vote — the
    // engine would 409 "already decided". Drive the idempotent completion straight from the staged
    // outcome instead, recovering the stranded record on the next decide attempt.
    const status = await this.approvals.getStatus(ApprovalRecordType.ExpenseReport, reportId);
    if (status?.completed && status.outcome) {
      return this.applyCompletion(reportId, status.outcome, userId);
    }

    const decision =
      input.decision === 'rejected' ? ApprovalDecision.Rejected : ApprovalDecision.Approved;

    // Drive the engine (its own tenant tx): records the vote, advances/short-circuits the chain, and
    // stages ApprovalCompleted on a terminal state. Throws forbidden for a non-approver, conflict for
    // a double vote — both surface to the caller unchanged.
    const result = await this.approvals.decide({
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: reportId,
      approverId: userId,
      decision,
      comment: input.comment,
    });

    // Mirror each recorded vote onto the report's own decision ledger + timeline so the existing
    // expense_approvals / activity feed stays populated (the engine owns the chain; expense owns the
    // record). Level comes from the slot the approver just cleared.
    await this.recordDecisionTrail(reportId, userId, decision, input.comment, result);

    // In-process ApprovalCompleted handling (no worker): on a terminal chain, advance the report.
    if (result.completed && result.outcome) {
      return this.applyCompletion(reportId, result.outcome, userId);
    }

    // Chain still open: report remains in APPROVALS.
    return withTenantTransaction(async (t) => {
      const fresh = (await this.reports.findReportById(
        reportId,
        t,
      )) as ExpenseShape.ExpenseReportRow;
      return this.toReportDto(fresh);
    });
  }

  /**
   * BUG-0005 — event-driven recovery of a stranded report. The per-service ApprovalCompleted consumer
   * (worker role) calls this when it relays a (possibly re-delivered) ApprovalCompleted: it drives the
   * SAME idempotent {@link applyCompletion} the in-request path uses, so a stranded report (vote
   * committed but the in-request advance failed) is advanced from the staged event, and a double
   * delivery is a no-op (applyCompletion returns the already-terminal report unchanged).
   */
  async applyCompletionFromEvent(
    reportId: string,
    outcome: ApprovalShape.ChainOutcome,
    decidedBy: string,
  ): Promise<void> {
    await this.applyCompletion(reportId, outcome, decidedBy);
  }

  /**
   * BUG-0003 — apply a workflow `assign_team` / `add_tag` rule action to the record it targets, under
   * the tenant context the bus rebuilt from the envelope. SETs the owning team and UNIONs the
   * classification tags (distinct), then records a `record_updated` shared-timeline entry. Idempotent
   * + again-safe: re-applying the same team/tags is a no-op, so an at-least-once redelivery changes
   * nothing.
   */
  async applyRecordUpdate(
    reportId: string,
    update: {
      teamId?: string | null;
      assigneeId?: string | null;
      tags?: string[];
      removeTags?: string[];
      ruleId?: string;
    },
  ): Promise<void> {
    if (!(await FeatureFlags.isEnabled(RecordAnnotationFeatureFlag))) return;
    await withTenantTransaction(async (t) => {
      const row = await this.reports.findReportById(reportId, t);
      if (!row) throw ErrUtils.notFound('Expense report not found');
      let tagCache: string[] | undefined;
      if (update.tags && update.tags.length > 0) {
        tagCache = (
          await attachRecordTags({
            recordType: ApprovalRecordType.ExpenseReport,
            recordId: reportId,
            tags: update.tags,
            existingTags: row.tags,
            source: 'workflow',
            transaction: t,
            createMissingCatalogTags: true,
          })
        ).tags;
      }
      if (update.removeTags && update.removeTags.length > 0) {
        tagCache = (
          await detachRecordTags({
            recordType: ApprovalRecordType.ExpenseReport,
            recordId: reportId,
            tags: update.removeTags,
            transaction: t,
          })
        ).tags;
      }
      const patch = computeLabelPatch(row, {
        ...update,
        tags: tagCache ?? update.tags,
        replaceTags: tagCache !== undefined,
      });
      if (!patch) return; // nothing changed — idempotent no-op (again-safe on redelivery)

      await this.reports.applyLabels(reportId, patch.write, t);
      await ActivityLogger.record(
        {
          recordType: ApprovalRecordType.ExpenseReport,
          recordId: reportId,
          action: 'record_updated',
          details: {
            teamId: patch.write.team_id,
            assigneeId: patch.write.assignee_id,
            tagsAdded: patch.added,
            tagsRemoved: patch.removed,
            ruleId: update.ruleId,
          },
        },
        t,
      );
    });
  }

  /**
   * Apply a completed approval chain to the report (the in-process ApprovalCompleted handler).
   * `approved` → APPROVED (+ ERP push); `rejected` → REJECTED. Idempotent + again-safe: if the report
   * is already in the target terminal state we return it unchanged (a replayed completion is a no-op),
   * which keeps both the engine-driven `decideReport` path and any future event-relay handler safe to
   * call more than once.
   */
  private async applyCompletion(
    reportId: string,
    outcome: ApprovalShape.ChainOutcome,
    decidedBy: string,
  ): Promise<ExpenseShape.ExpenseReportDto> {
    const target =
      outcome === 'approved' ? ExpenseReportStatus.Approved : ExpenseReportStatus.Rejected;

    const result = await withTenantTransaction(async (t) => {
      const report = await this.reports.findReportById(reportId, t);
      if (!report) throw ErrUtils.notFound('Expense report not found');

      // Idempotency: already in the terminal state ⇒ no-op (again-safe completion).
      if (report.status === target) {
        return { report, changed: false };
      }

      const updated = (await this.reports.updateReport(
        reportId,
        { status: target },
        t,
      )) as ExpenseShape.ExpenseReportRow;

      await this.writeActivity(
        reportId,
        decidedBy,
        outcome === 'approved'
          ? ExpenseActivityType.ReportApproved
          : ExpenseActivityType.ReportRejected,
        { from: report.status, to: target, via: 'approval_engine' },
        t,
      );

      await AuditLogger.record(
        {
          action: AuditAction.StateTransition,
          outcome: AuditOutcome.Success,
          resourceType: 'expense_report',
          resourceId: reportId,
          details: { to: target },
        },
        t,
      );

      const expenses = await this.expenses.listExpensesForReport(reportId, t);

      if (outcome === 'approved') {
        await this.publish(
          EventTopic.ExpenseApproved,
          {
            reportId: updated.id,
            status: ExpenseReportStatus.Approved,
            approvedBy: decidedBy,
            amountMinor: Number(updated.total_amount),
            recipientUserId: updated.submitter_id,
          },
          t,
        );
        await this.publish(
          EventTopic.ConnectorPushRequested,
          {
            connectorKind: ConnectorKind.LedgerOne,
            entity: ConnectorEntity.Expense,
            idempotencyKey: updated.id,
            recordType: ApprovalRecordType.ExpenseReport,
            recordId: updated.id,
            data: this.connectorPayloadForReport(updated, expenses),
            ruleId: 'expense.approve',
          },
          t,
        );
      } else {
        await this.publish(
          EventTopic.ExpenseRejected,
          {
            reportId: updated.id,
            status: ExpenseReportStatus.Rejected,
            rejectedBy: decidedBy,
            recipientUserId: updated.submitter_id,
          },
          t,
        );
      }

      return { report: updated, changed: true };
    });

    return this.toReportDto(result.report);
  }

  /**
   * Mirror an engine-recorded vote onto the report's own `expense_approvals` ledger + activity feed.
   * The shared engine owns the authoritative chain/vote; expense keeps its per-report decision rows
   * (and timeline) populated for the report-detail view. The level is the slot the approver cleared.
   */
  private async recordDecisionTrail(
    reportId: string,
    approverId: string,
    decision: ApprovalDecision,
    comment: string | undefined,
    result: ApprovalShape.DecisionResult,
  ): Promise<void> {
    const tenantId = RequestContext.tenantId();
    const slot = result.chain.find((r) => r.approver_id === approverId);
    const level = slot?.level ?? 1;
    await withTenantTransaction(async (t) => {
      await this.reports.createApproval(
        {
          tenant_id: tenantId,
          report_id: reportId,
          approver_id: approverId,
          decision:
            decision === ApprovalDecision.Approved
              ? ExpenseDecision.Approved
              : ExpenseDecision.Rejected,
          level,
          comment,
        },
        t,
      );
    });
  }

  /**
   * APPROVALS → REJECTED. Manager-of-submitter or admin (mirrors approve). Writes an
   * expense_approvals row with decision=rejected + a ReportRejected activity, records an audit
   * state-transition, and emits ExpenseRejected so the submitter is notified. No ERP push — a
   * rejected report never reaches the ledger. The submitter may later revise & resubmit
   * (REJECTED → OPEN, per the SUBMITTER transition map).
   */
  async rejectReport(
    reportId: string,
    input: ExpenseShape.RejectInput,
  ): Promise<ExpenseShape.ExpenseReportDto> {
    const tenantId = RequestContext.tenantId();
    const userId = this.requireUser();
    const reason = input.reason ?? input.comment;
    const result = await withTenantTransaction(async (t) => {
      const report = await this.reports.findReportById(reportId, t);
      if (!report) throw ErrUtils.notFound('Expense report not found');

      this.assertTransition(report, ExpenseReportStatus.Rejected, 'manager');

      const updated = (await this.reports.updateReport(
        reportId,
        { status: ExpenseReportStatus.Rejected },
        t,
      )) as ExpenseShape.ExpenseReportRow;

      await this.reports.createApproval(
        {
          tenant_id: tenantId,
          report_id: reportId,
          approver_id: userId,
          decision: ExpenseDecision.Rejected,
          level: 1,
          comment: reason,
        },
        t,
      );
      await this.writeActivity(
        reportId,
        userId,
        ExpenseActivityType.ReportRejected,
        { from: report.status, to: ExpenseReportStatus.Rejected, reason },
        t,
      );

      await AuditLogger.record(
        {
          action: AuditAction.StateTransition,
          outcome: AuditOutcome.Success,
          resourceType: 'expense_report',
          resourceId: reportId,
          details: { to: ExpenseReportStatus.Rejected },
        },
        t,
      );

      // Stage in the SAME tx as the rejection write (transactional outbox) — atomic with the write.
      await this.publish(
        EventTopic.ExpenseRejected,
        {
          reportId: updated.id,
          status: ExpenseReportStatus.Rejected,
          rejectedBy: userId,
          reason,
          // Recipient hint: notify the submitter their report was rejected. Tenant comes from the envelope.
          recipientUserId: updated.submitter_id,
        },
        t,
      );

      return updated;
    });

    return this.toReportDto(result);
  }

  /**
   * APPROVED → REIMBURSED. Finance (FinanceDisburser) or admin. Records the disbursement as a
   * ReportReimbursed activity + an audit state-transition. Activates the previously-dead FINANCE
   * transition map/branch. Terminal state — no further transition and no event contract today.
   */
  async reimburseReport(
    reportId: string,
    input: ExpenseShape.ReimburseInput,
  ): Promise<ExpenseShape.ExpenseReportDto> {
    const userId = this.requireUser();
    return withTenantTransaction(async (t) => {
      const report = await this.reports.findReportById(reportId, t);
      if (!report) throw ErrUtils.notFound('Expense report not found');

      this.assertTransition(report, ExpenseReportStatus.Reimbursed, 'finance');

      const updated = (await this.reports.updateReport(
        reportId,
        { status: ExpenseReportStatus.Reimbursed },
        t,
      )) as ExpenseShape.ExpenseReportRow;

      await this.writeActivity(
        reportId,
        userId,
        ExpenseActivityType.ReportReimbursed,
        { from: report.status, to: ExpenseReportStatus.Reimbursed, comment: input.comment },
        t,
      );

      await AuditLogger.record(
        {
          action: AuditAction.StateTransition,
          outcome: AuditOutcome.Success,
          resourceType: 'expense_report',
          resourceId: reportId,
          details: { to: ExpenseReportStatus.Reimbursed },
        },
        t,
      );

      return this.toReportDto(updated);
    });
  }

  // ---- ERP payload ----

  /** Header-level expense payload staged for the connector worker; the request path never calls ERP. */
  private connectorPayloadForReport(
    report: ExpenseShape.ExpenseReportRow,
    expenses: ExpenseShape.ExpenseRow[],
  ): Record<string, unknown> {
    return {
      reportId: report.id,
      reportNumber: Number(report.report_number),
      name: report.name,
      currency: report.currency,
      totalAmount: Number(report.total_amount),
      items: expenses.map((e) => ({
        amount: Number(e.amount),
        currency: e.currency,
        merchant: e.merchant,
        incurredOn: e.incurred_on,
        categoryId: e.category_id,
        receiptRef: e.receipt_ref,
      })),
    };
  }

  // ---- transition + scope helpers ----

  /**
   * Enforce the single-currency-per-report invariant: a report's denormalized `total_amount` is a
   * plain BIGINT minor-units sum, which is only meaningful when every line shares one currency. We
   * reject mixing rather than silently summing across currencies (which would push a nonsensical
   * total to the ERP). FX conversion is intentionally out of scope here.
   */
  private assertItemCurrencyMatches(itemCurrency: string, reportCurrency: string): void {
    if (itemCurrency !== reportCurrency) {
      throw ErrUtils.validation(
        `Expense currency ${itemCurrency} does not match report currency ${reportCurrency}`,
      );
    }
  }

  private assertEditable(report: ExpenseShape.ExpenseReportRow): void {
    if (report.status !== ExpenseReportStatus.Open) {
      throw ErrUtils.conflict('Report is not editable in its current status');
    }
    if (!this.isAdmin() && report.submitter_id !== this.requireUser()) {
      throw ErrUtils.forbidden('Only the submitter may edit this report');
    }
  }

  /**
   * Validate a role-keyed status transition. `admin` may take any structurally valid edge
   * (union of all role maps); otherwise the principal's effective role for this report must
   * permit the edge. Same→same is rejected (no-op).
   */
  private assertTransition(
    report: ExpenseShape.ExpenseReportRow,
    to: ExpenseReportStatus,
    role: 'submitter' | 'manager' | 'finance',
  ): void {
    const from = report.status as ExpenseReportStatus;
    if (from === to) throw ErrUtils.conflict('No-op transition');

    if (this.isAdmin()) {
      if (!this.anyMapAllows(from, to)) {
        throw ErrUtils.conflict(`Illegal transition ${from} → ${to}`);
      }
      return;
    }

    if (role === 'submitter' && report.submitter_id !== this.requireUser()) {
      throw ErrUtils.forbidden('Only the submitter may take this action');
    }
    const map = this.mapFor(role);
    const allowed = map[from] ?? [];
    if (!allowed.includes(to)) {
      throw ErrUtils.forbidden(`Role '${role}' may not transition ${from} → ${to}`);
    }
  }

  private mapFor(
    role: 'submitter' | 'manager' | 'finance',
  ): Partial<Record<ExpenseReportStatus, ExpenseReportStatus[]>> {
    switch (role) {
      case 'submitter':
        return ExpenseReportTransitions.SUBMITTER;
      case 'manager':
        return ExpenseReportTransitions.MANAGER;
      case 'finance':
        return ExpenseReportTransitions.FINANCE;
    }
  }

  private anyMapAllows(from: ExpenseReportStatus, to: ExpenseReportStatus): boolean {
    return [
      ExpenseReportTransitions.SUBMITTER,
      ExpenseReportTransitions.MANAGER,
      ExpenseReportTransitions.FINANCE,
    ].some((map) => (map[from] ?? []).includes(to));
  }

  /** Row-scope: a plain submitter/contributor only lists their own reports; manager/admin see all. */
  private rowScopeSubmitterFilter(): string | undefined {
    if (this.isAdmin()) return undefined;
    const roles = RequestContext.roles();
    if (roles.includes(SystemRole.Manager) || roles.includes(SystemRole.Approver)) return undefined;
    return this.requireUser();
  }

  private isAdmin(): boolean {
    const roles = RequestContext.roles();
    return roles.includes(SystemRole.Admin) || roles.includes(SystemRole.Owner);
  }

  private requireUser(): string {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');
    return userId;
  }

  // ---- audit + events ----

  private async writeActivity(
    reportId: string,
    userId: string | null,
    activityType: ExpenseActivityType,
    details: Record<string, unknown>,
    t: Transaction,
  ): Promise<void> {
    await this.reports.createActivity(
      {
        tenant_id: RequestContext.tenantId(),
        report_id: reportId,
        user_id: userId,
        activity_type: activityType,
        details,
      },
      t,
    );
    // Also append to the SHARED, polymorphic business timeline (@aegis/activity), keyed by the same
    // `(expense_report, reportId)` the approval engine uses — one cross-service who-did-what feed at
    // submit/approve/reject (the reusable pattern invoice/payroll copy). Same RLS tx.
    await ActivityLogger.record(
      {
        recordType: ApprovalRecordType.ExpenseReport,
        recordId: reportId,
        action: activityType,
        actorId: userId,
        details,
      },
      t,
    );
  }

  /**
   * Stage a domain event into the transactional outbox INSIDE the caller's transaction (W2-06), so the
   * event is persisted ATOMICALLY with the business write — no post-commit dual-write window. The relay
   * drains it to the bus at-least-once. The envelope captures the typed payload + tenant/correlation
   * from the active RequestContext.
   */
  private async publish<T extends EventTopic>(
    topic: T,
    payload: PayloadOf<T>,
    t: Transaction,
  ): Promise<void> {
    await stageOutboxEvent(makeEnvelope(topic, payload), t);
  }

  // ---- DTO mappers ----

  private toReportDto(row: ExpenseShape.ExpenseReportRow): ExpenseShape.ExpenseReportDto {
    return {
      id: row.id,
      reportNumber: Number(row.report_number),
      name: row.name,
      status: row.status as ExpenseReportStatus,
      submitterId: row.submitter_id,
      teamId: row.team_id ?? null,
      assigneeId: row.assignee_id ?? null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      totalAmount: Number(row.total_amount),
      currency: row.currency,
      submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
      syncedAt: row.synced_at ? new Date(row.synced_at).toISOString() : null,
    };
  }

  private toExpenseDto(row: ExpenseShape.ExpenseRow): ExpenseShape.ExpenseDto {
    return {
      id: row.id,
      reportId: row.report_id,
      categoryId: row.category_id,
      amount: Number(row.amount),
      currency: row.currency,
      merchant: row.merchant,
      incurredOn: row.incurred_on,
      description: row.description,
      receiptRef: row.receipt_ref,
      createdBy: row.created_by,
    };
  }

  private toApprovalDto(row: ExpenseShape.ExpenseApprovalRow): ExpenseShape.ApprovalDto {
    return {
      id: row.id,
      approverId: row.approver_id,
      decision: row.decision,
      level: row.level,
      comment: row.comment,
      decidedAt: new Date(row.decided_at).toISOString(),
    };
  }

  private toCommentDto(row: ExpenseShape.ExpenseCommentRow): ExpenseShape.CommentDto {
    return {
      id: row.id,
      reportId: row.report_id,
      userId: row.user_id,
      body: row.body,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  private toActivityDto(row: ExpenseShape.ExpenseActivityRow): ExpenseShape.ActivityDto {
    return {
      id: row.id,
      userId: row.user_id,
      activityType: row.activity_type,
      details: row.details,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }
}
