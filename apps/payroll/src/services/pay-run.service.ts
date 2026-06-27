import { createHash } from 'node:crypto';
import type { Transaction } from 'sequelize';
import { inject } from 'inversify';
import { ErrUtils, FeatureFlags, RequestContext } from '@aegis/service-core';
import {
  PayRunStatus,
  PayRunType,
  PayslipStatus,
  PayItemKind,
  PaymentStatus,
  LedgerAccount,
  ConnectorKind,
  ConnectorEntity,
  AuditAction,
  AuditOutcome,
  ApprovalRecordType,
  ApprovalDecision,
} from '@aegis/shared-enums';
import {
  RecordAnnotationFeatureFlag,
  attachRecordTags,
  detachRecordTags,
  withTenantTransaction,
} from '@aegis/db';
import { makeEnvelope, stageOutboxEvent, EventTopic } from '@aegis/events';
import { AuditLogger } from '@aegis/audit';
import { ActivityLogger } from '@aegis/activity';
import { ApprovalService } from '@aegis/approvals';
import { PayrollShape, type ApprovalShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { EmployeeRepository } from '../repositories/employee.repository';
import { PayRunRepository } from '../repositories/pay-run.repository';
import { encryptField } from '../utils/field-crypto';
import { deductionPreTaxFlag, totalTaxForRules } from '../utils/tax-engine';

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

interface PayslipAccess {
  canViewAll: boolean;
}

/**
 * The pay-run engine + lifecycle. Drives the strict state machine
 * Draft → Calculated → Approved → Paid. Approval is delegated to the shared multi-level engine
 * `@aegis/approvals` (keyed `(pay_run, runId)`), replacing the old single-shot inline approve, while
 * maker-checker SEGREGATION OF DUTIES is preserved as a hard domain invariant (the engine's policy
 * `excludeRequester` AND an in-service guard that a run's creator can never approve their own run).
 * Disbursement stays gated on the Approved status and is backed by idempotent payments + an
 * append-only double-entry ledger.
 */
@provideSingleton(PayRunService)
export class PayRunService {
  constructor(
    @inject(PayRunRepository) private readonly repo: PayRunRepository,
    @inject(EmployeeRepository) private readonly employees: EmployeeRepository,
    // The shared multi-level approval engine, injected via the reusable `registerApprovalProviders()`
    // wiring in `ioc/loader.ts` (the template expense/invoice copy). Tenant-scoped internally.
    @inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  // ---- create → Draft ----

  async list(
    filter: PayrollShape.PayRunListFilter,
    page: number,
    pageSize: number,
  ): Promise<PayrollShape.PayRunListResult> {
    return withTenantTransaction(async (t) => {
      const { rows, total } = await this.repo.listPayRuns(filter, page, pageSize, t);
      return { data: rows.map((row) => this.toDto(row)), meta: { total, page, pageSize } };
    });
  }

  async get(payRunId: string): Promise<PayrollShape.PayRunDto> {
    return withTenantTransaction(async (t) => this.toDto(await this.loadOrThrow(payRunId, t)));
  }

  async listPayslips(
    filter: PayrollShape.PayslipListFilter,
    page: number,
    pageSize: number,
    access: PayslipAccess,
  ): Promise<PayrollShape.PayslipListResult> {
    return withTenantTransaction(async (t) => {
      const scopedFilter = access.canViewAll ? filter : { ...filter, userId: this.requireUser() };
      const { rows, total } = await this.repo.listPayslips(scopedFilter, page, pageSize, t);
      return { data: rows.map((row) => this.toPayslipDto(row)), meta: { total, page, pageSize } };
    });
  }

  async getPayslip(payslipId: string, access: PayslipAccess): Promise<PayrollShape.PayslipDto> {
    return withTenantTransaction(async (t) => {
      const row = access.canViewAll
        ? await this.repo.findPayslipById(payslipId, t)
        : await this.repo.findPayslipByIdForUser(payslipId, this.requireUser(), t);
      if (!row) throw ErrUtils.notFound('Payslip not found');
      return this.toPayslipDto(row);
    });
  }

  async create(input: PayrollShape.CreatePayRunInput): Promise<PayrollShape.PayRunDto> {
    const tenantId = RequestContext.tenantId();
    const createdBy = this.requireUser();
    return withTenantTransaction(async (t) => {
      const run = await this.repo.createPayRun(
        {
          tenant_id: tenantId,
          pay_calendar_id: input.payCalendarId ?? null,
          period_start: input.periodStart,
          period_end: input.periodEnd,
          pay_date: input.payDate,
          type: input.type ?? PayRunType.Regular,
          status: PayRunStatus.Draft,
          created_by: createdBy,
        },
        t,
      );
      // Seed a payslip shell per requested employee so calculate() has rows to compute against. The
      // shell currency is the employee's effective contract currency on the pay date (W5-09 — not a
      // hard-coded 'USD'); calculate() re-resolves it, but seeding it correctly keeps the shell honest.
      for (const employeeId of input.employeeIds ?? []) {
        const currency =
          (await this.employees.findContractCurrencyForEmployee(employeeId, run.pay_date, t)) ??
          'USD';
        await this.repo.createPayslip(
          {
            tenant_id: tenantId,
            pay_run_id: run.id,
            employee_id: employeeId,
            gross: 0,
            taxable_base: 0,
            total_tax: 0,
            total_deductions: 0,
            net_enc: null,
            currency,
            status: PayslipStatus.Draft,
          },
          t,
        );
      }
      // W5-13 — append the pay-run creation to the SHARED business timeline (same RLS tx).
      await this.writeActivity(
        run.id,
        createdBy,
        'created',
        {
          status: PayRunStatus.Draft,
          type: run.type,
          employeeCount: (input.employeeIds ?? []).length,
        },
        t,
      );
      return this.toDto(run);
    });
  }

  // ---- calculate → Calculated ----

  async calculate(payRunId: string): Promise<PayrollShape.PayRunDto> {
    return withTenantTransaction(async (t) => {
      const run = await this.loadOrThrow(payRunId, t);
      this.assertStatus(run, PayRunStatus.Draft);

      const payslips = await this.repo.listPayslipsByRun(run.id, t);
      for (const slip of payslips) {
        // Only pay items whose effective-date window contains the run's pay date — a future-dated raise
        // or an already-ended recurring deduction must not be summed into this period (mirrors the
        // effective-dated tax-rule / contract-currency lookups below).
        const items = await this.employees.findActivePayItemsForEmployee(
          slip.employee_id,
          run.pay_date,
          t,
        );
        // Resolve the per-employee tax context: jurisdiction (employee master), effective-dated
        // tax_rules for the pay date, the deduction-code catalog (pre-tax flags), and the
        // contract currency. Tax + pre-tax handling are now REAL, not hard-coded (W5-05/W5-09).
        const employee = await this.employees.findEmployeeById(slip.employee_id, t);
        const deductionIds = items
          .filter((i) => i.code_kind === PayItemKind.Deduction && i.code_id)
          .map((i) => i.code_id as string);
        const deductionCodes = await this.employees.findDeductionCodesByIds(deductionIds, t);
        const taxRules = employee?.work_jurisdiction
          ? await this.employees.findEffectiveTaxRules(employee.work_jurisdiction, run.pay_date, t)
          : [];
        const currency = await this.resolveCurrency(slip, run.pay_date, t);

        const computed = this.computeForEmployee(items, deductionCodes, taxRules);
        await this.repo.updatePayslipTotals(
          slip.id,
          {
            gross: computed.gross,
            taxable_base: computed.taxableBase,
            total_tax: computed.totalTax,
            total_deductions: computed.totalDeductions,
            net_enc: encryptField(String(computed.net)), // net is field-encrypted
            currency,
            status: PayslipStatus.Calculated,
          },
          t,
        );
      }

      // Version-checked transition (W5-07): a concurrent calculate/edit that bumped the version first
      // makes this stale write match zero rows and lose, instead of racing past `assertStatus`.
      const updated = await this.repo.updatePayRunVersioned(
        run.id,
        run.lock_version ?? 0,
        { status: PayRunStatus.Calculated },
        t,
      );
      // W5-13 — record the calculate transition on the shared timeline (same RLS tx).
      await this.writeActivity(
        run.id,
        RequestContext.userId() ?? null,
        'calculated',
        { from: PayRunStatus.Draft, to: PayRunStatus.Calculated, payslipCount: payslips.length },
        t,
      );
      return this.toDto(updated);
    });
  }

  /**
   * Pure aggregation: gross / taxable_base / total_tax / total_deductions / net, all minor units.
   *
   * PRE-tax deductions (resolved from each deduction's `deduction_codes` row via {@link deductionPreTaxFlag})
   * reduce the taxable base BEFORE tax; POST-tax deductions only reduce net. Tax is resolved from the
   * effective-dated `tax_rules` for the employee's jurisdiction (passed in) and applied to the taxable
   * base — with no resolved rules the lookup path yields zero tax (the seeded/empty case stays correct,
   * but via the data path, not a hard-coded `0`). A deduction with no `code_id`/code row is treated as
   * POST-tax (conservative: it never silently shrinks the taxed amount).
   */
  private computeForEmployee(
    items: PayrollShape.EmployeePayItemRow[],
    deductionCodes: Map<string, PayrollShape.DeductionCodeRow>,
    taxRules: ReadonlyArray<PayrollShape.TaxRuleRow>,
  ): PayrollShape.PayslipComputation {
    let gross = 0;
    let preTaxDeductions = 0;
    let postTaxDeductions = 0;
    for (const item of items) {
      const amount = Number(item.amount_or_rate);
      if (item.code_kind === PayItemKind.Earning) {
        gross += amount;
      } else if (item.code_kind === PayItemKind.Deduction) {
        const code = item.code_id ? deductionCodes.get(item.code_id) : undefined;
        if (deductionPreTaxFlag(code)) {
          preTaxDeductions += amount;
        } else {
          postTaxDeductions += amount;
        }
      }
    }
    // Pre-tax deductions shrink the taxable base; tax is DATA resolved from tax_rules (zero if none).
    const taxableBase = Math.max(0, gross - preTaxDeductions);
    const totalTax = totalTaxForRules(taxableBase, taxRules);
    const totalDeductions = preTaxDeductions + postTaxDeductions;
    // net = gross − tax − ALL deductions (both pre- and post-tax leave the paycheck).
    const net = gross - totalTax - totalDeductions;
    if (net < 0) {
      throw ErrUtils.validation('Calculation would drive net pay below zero');
    }
    return { gross, taxableBase, totalTax, totalDeductions, net };
  }

  /**
   * The currency to label a payslip + its ledger postings (W5-09). Prefer the employee's effective
   * employment-contract currency on the pay date; fall back to the payslip's existing currency (the
   * shell seed) so a contract-less employee still gets a stable, non-hard-coded label.
   */
  private async resolveCurrency(
    slip: PayrollShape.PayslipRow,
    payDate: string,
    t: Transaction,
  ): Promise<string> {
    const contractCurrency = await this.employees.findContractCurrencyForEmployee(
      slip.employee_id,
      payDate,
      t,
    );
    return contractCurrency ?? slip.currency;
  }

  // ---- decide → Approved / (stay Calculated on rejection) — MAKER-CHECKER via the shared engine ----

  /**
   * Record one approver's decision on a CALCULATED pay run through the shared multi-level approval
   * engine, then advance the run when the chain completes — the engine-backed replacement for the old
   * single-shot `approve()`. Guarded by the `PayRunApprove` permission at the controller.
   *
   * Flow: a CALCULATED run lazily materialises its approver chain on first decision via
   * `ApprovalService.requestApproval({ PayRun, runId, requestedBy: creator })` (idempotent — a second
   * decision reuses the existing chain). The seeded PayRun policy sets `excludeRequester`, so the
   * creator is never resolved into the chain (SoD at policy level). We ALSO keep a hard in-service SoD
   * guard so the creator can never approve their own run even if the policy were misconfigured. Then
   * `ApprovalService.decide(...)` appends the immutable vote + advances/short-circuits the chain (the
   * engine enforces no-double-vote and that the principal is a PENDING approver — a non-approver gets a
   * 403 from the engine). When the chain reports COMPLETED we advance the pay-run status IN PROCESS
   * here: approved → Approved (snapshot + PayRunApproved event), rejected → stays Calculated (the maker
   * may revise & re-route). The status advance is idempotent (a run already Approved is a no-op), so a
   * replayed ApprovalCompleted / re-issued decide is again-safe without a separate worker.
   */
  async decide(
    payRunId: string,
    input: PayrollShape.DecidePayRunInput,
  ): Promise<PayrollShape.PayRunDto> {
    const approver = this.requireUser();

    // Pre-flight (RLS-scoped): the run must exist (404) and be CALCULATED (else the decision is moot).
    const run = await withTenantTransaction((t) => this.loadOrThrow(payRunId, t));
    this.assertStatus(run, PayRunStatus.Calculated);

    // SoD — a HARD domain invariant (defence-in-depth alongside the policy's `excludeRequester`). The
    // principal who created/edited the run's inputs may never approve it, even if they hold the
    // permission and even if the policy were misconfigured to resolve them into the chain.
    this.assertSegregationOfDuties(run, approver);

    // BUG-0005 SELF-HEAL: if the engine chain is ALREADY approved but the run is still stranded in
    // CALCULATED (the in-request advance failed after the closing vote committed), don't re-vote — the
    // engine would 409 "already decided". Drive the idempotent completion straight from the staged
    // outcome instead, recovering the stranded run on the next decide attempt. (A rejected chain
    // legitimately leaves the run CALCULATED for revision, so only an approved terminal self-heals.)
    const status = await this.approvals.getStatus(ApprovalRecordType.PayRun, run.id);
    if (status?.completed && status.outcome === 'approved') {
      return this.applyCompletion(payRunId, 'approved', approver);
    }

    // Lazily materialise the approver chain (idempotent): keyed `(pay_run, runId)`, requestedBy = the
    // CREATOR (the SoD requester the engine excludes). A re-decision reuses the existing chain.
    const chain = await this.approvals.requestApproval({
      recordType: ApprovalRecordType.PayRun,
      recordId: run.id,
      requestedBy: run.created_by,
    });

    // An EMPTY chain means the engine auto-completed as approved (no required approver — e.g. SoD
    // excluded the only candidate, or the tenant has no policy/hierarchy). Honour it immediately by
    // advancing the run straight to Approved (the same path a completed decide takes).
    if (chain.chain.length === 0) {
      return this.applyCompletion(payRunId, 'approved', approver);
    }

    const decision =
      input.decision === 'rejected' ? ApprovalDecision.Rejected : ApprovalDecision.Approved;

    // Drive the engine (its own tenant tx): records the vote, advances/short-circuits the chain, and
    // stages ApprovalCompleted on a terminal state. Throws forbidden for a non-approver, conflict for a
    // double vote — both surface to the caller unchanged.
    const result = await this.approvals.decide({
      recordType: ApprovalRecordType.PayRun,
      recordId: run.id,
      approverId: approver,
      decision,
      comment: input.comment,
    });

    // In-process ApprovalCompleted handling (no worker): on a terminal chain, advance the run.
    if (result.completed && result.outcome) {
      return this.applyCompletion(payRunId, result.outcome, approver);
    }

    // Chain still open: the run remains Calculated.
    return withTenantTransaction(async (t) => this.toDto(await this.loadOrThrow(payRunId, t)));
  }

  /**
   * Backward-compatible single-vote approve: an alias for `decide({ decision: 'approved' })`. The
   * inline single-shot approve is GONE — this routes through the shared engine like every decision.
   */
  async approve(payRunId: string, comment?: string): Promise<PayrollShape.PayRunDto> {
    return this.decide(payRunId, { decision: 'approved', comment });
  }

  /**
   * The current user's PENDING pay-run approval slots — their "approvals inbox". Asks the shared
   * engine for the live, still-pending `record_approvers` slots this principal owns for
   * `ApprovalRecordType.PayRun`, then hydrates each with its run header (RLS-scoped) so the caller
   * gets actionable rows, not bare slot ids.
   */
  async listPendingApprovals(): Promise<PayrollShape.PendingPayRunApprovalDto[]> {
    const userId = this.requireUser();
    const slots = await this.approvals.listPendingForApprover(userId, ApprovalRecordType.PayRun);
    if (slots.length === 0) return [];
    return withTenantTransaction(async (t) => {
      const out: PayrollShape.PendingPayRunApprovalDto[] = [];
      for (const slot of slots) {
        const run = await this.repo.findPayRunById(slot.record_id, t);
        if (!run) continue; // RLS-invisible / deleted ⇒ drop from the inbox
        out.push({ payRunId: run.id, level: slot.level, payRun: this.toDto(run) });
      }
      return out;
    });
  }

  /**
   * BUG-0005 — event-driven recovery of a stranded pay run. The per-service ApprovalCompleted consumer
   * (worker role) calls this when it relays a (possibly re-delivered) ApprovalCompleted: it drives the
   * SAME idempotent {@link applyCompletion} the in-request path uses, so a stranded run (closing vote
   * committed but the in-request advance failed) is advanced from the staged event, and a double
   * delivery is a no-op (an already-Approved run is returned unchanged).
   */
  async applyCompletionFromEvent(
    payRunId: string,
    outcome: ApprovalShape.ChainOutcome,
    decidedBy: string,
  ): Promise<void> {
    await this.applyCompletion(payRunId, outcome, decidedBy);
  }

  /**
   * BUG-0003 — apply a workflow `assign_team` / `add_tag` rule action to the record it targets, under
   * the tenant context the bus rebuilt from the envelope. SETs the owning team and UNIONs the
   * classification tags (distinct), then records a `record_updated` shared-timeline entry. Idempotent
   * + again-safe: re-applying the same team/tags is a no-op, so an at-least-once redelivery changes
   * nothing.
   */
  async applyRecordUpdate(
    payRunId: string,
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
      const row = await this.loadOrThrow(payRunId, t);
      let tagCache: string[] | undefined;
      if (update.tags && update.tags.length > 0) {
        tagCache = (
          await attachRecordTags({
            recordType: ApprovalRecordType.PayRun,
            recordId: payRunId,
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
            recordType: ApprovalRecordType.PayRun,
            recordId: payRunId,
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

      await this.repo.applyLabels(payRunId, patch.write, t);
      await this.writeActivity(
        payRunId,
        RequestContext.userId() ?? null,
        'record_updated',
        {
          teamId: patch.write.team_id,
          assigneeId: patch.write.assignee_id,
          tagsAdded: patch.added,
          tagsRemoved: patch.removed,
          ruleId: update.ruleId,
        },
        t,
      );
    });
  }

  /**
   * Apply a completed approval chain to the run (the in-process ApprovalCompleted handler).
   * `approved` → Approved (snapshot locked + PayRunApproved event + audit). `rejected` → the run stays
   * CALCULATED so the maker can revise & re-route (no Paid path is reachable from a rejection). The
   * approved transition is idempotent + again-safe: a run already Approved is returned unchanged, which
   * keeps both the engine-driven `decide` path and any future event-relay handler safe to call twice.
   */
  private async applyCompletion(
    payRunId: string,
    outcome: ApprovalShape.ChainOutcome,
    decidedBy: string,
  ): Promise<PayrollShape.PayRunDto> {
    return withTenantTransaction(async (t) => {
      const run = await this.loadOrThrow(payRunId, t);

      if (outcome === 'rejected') {
        // A rejected chain leaves the run CALCULATED (revisable). Record the rejection on the audit +
        // business timeline; no PayRunApproved event, no ledger, no Paid path.
        await this.writeActivity(payRunId, decidedBy, 'rejected', { via: 'approval_engine' }, t);
        await AuditLogger.record(
          {
            action: AuditAction.StateTransition,
            outcome: AuditOutcome.Failure,
            actorId: decidedBy,
            resourceType: 'pay_run',
            resourceId: payRunId,
            details: { decision: 'rejected', status: run.status },
          },
          t,
        );
        return this.toDto(run);
      }

      // Idempotency: already Approved ⇒ no-op (again-safe completion).
      if (run.status === PayRunStatus.Approved) return this.toDto(run);

      const snapshot = await this.snapshot(run.id, t);
      // Version-checked approve (W5-07): two checkers completing the chain concurrently can't both
      // pass `assertStatus` + write Approved — the stale writer's guarded update matches zero rows.
      const updated = await this.repo.updatePayRunVersioned(
        run.id,
        run.lock_version ?? 0,
        {
          status: PayRunStatus.Approved,
          approved_by: decidedBy,
          approved_at: new Date(),
          locked_snapshot: snapshot,
        },
        t,
      );
      await this.writeActivity(
        payRunId,
        decidedBy,
        'approved',
        { from: run.status, to: PayRunStatus.Approved, via: 'approval_engine' },
        t,
      );
      await AuditLogger.record(
        {
          action: AuditAction.StateTransition,
          outcome: AuditOutcome.Success,
          actorId: decidedBy,
          resourceType: 'pay_run',
          resourceId: run.id,
          details: { to: PayRunStatus.Approved },
        },
        t,
      );
      // Stage the domain event in the SAME tx as the approval write (transactional outbox): persisted
      // atomically with the approval, drained to the bus at-least-once by the relay — no dual-write gap.
      await stageOutboxEvent(
        makeEnvelope(EventTopic.PayRunApproved, {
          payRunId: run.id,
          approvedBy: decidedBy,
          // Recipient hint: notify the maker their run was approved. Tenant comes from the envelope.
          recipientUserId: run.created_by,
        }),
        t,
      );
      return this.toDto(updated);
    });
  }

  /**
   * SEGREGATION OF DUTIES — a hard domain invariant. The principal who created/edited a run's inputs
   * may never approve it, even if they hold the permission. This is a defence-in-depth guard ALONGSIDE
   * the seeded PayRun policy's `excludeRequester` (which already keeps the creator out of the resolved
   * chain): the guard holds even if a tenant misconfigured the policy.
   */
  private assertSegregationOfDuties(run: PayrollShape.PayRunRow, approver: string): void {
    if (run.created_by === approver) {
      throw ErrUtils.forbidden(
        'Segregation of duties: the approver must differ from the principal who created/edited the pay-run',
      );
    }
  }

  /** Immutable record of the computed result, locked at approval so a run can never be silently recomputed. */
  private async snapshot(payRunId: string, t: Transaction): Promise<unknown> {
    const payslips = await this.repo.listPayslipsByRun(payRunId, t);
    return {
      capturedAt: new Date().toISOString(),
      payslips: payslips.map((p) => ({
        id: p.id,
        employeeId: p.employee_id,
        gross: Number(p.gross),
        taxableBase: Number(p.taxable_base),
        totalTax: Number(p.total_tax),
        totalDeductions: Number(p.total_deductions),
        currency: p.currency,
      })),
    };
  }

  // ---- disburse → Paid (idempotent payments + append-only ledger + event + ERP push) ----

  async disburse(payRunId: string, idempotencyKey: string): Promise<PayrollShape.PayRunDto> {
    const tenantId = RequestContext.tenantId();
    if (!idempotencyKey) {
      throw ErrUtils.validation('Idempotency-Key header is required for disbursement');
    }
    return withTenantTransaction(async (t) => {
      const run = await this.loadOrThrow(payRunId, t);
      this.assertStatus(run, PayRunStatus.Approved);

      const payslips = await this.repo.listPayslipsByRun(run.id, t);
      const batch = await this.repo.createPaymentBatch(
        { tenant_id: tenantId, pay_run_id: run.id, status: PaymentStatus.Submitted },
        t,
      );

      // Ledger postings are single-currency per run: assert every payslip shares one currency so a
      // multi-currency run never silently nets disparate currencies into one balanced entry (W5-09).
      const runCurrency = this.assertSingleCurrency(payslips);

      let totalNet = 0;
      let totalTax = 0;
      let totalDeductions = 0;
      for (const slip of payslips) {
        // net = gross − tax − ALL deductions (total_deductions = pre + post; both leave the paycheck).
        const net = Number(slip.gross) - Number(slip.total_tax) - Number(slip.total_deductions);
        totalNet += net;
        totalTax += Number(slip.total_tax);
        totalDeductions += Number(slip.total_deductions);

        const paymentKey = `${idempotencyKey}:${slip.id}`;
        const existing = await this.repo.findPaymentByIdempotencyKey(paymentKey, t);
        if (!existing) {
          await this.repo.createPayment(
            {
              tenant_id: tenantId,
              payslip_id: slip.id,
              batch_id: batch.id,
              amount: net,
              currency: slip.currency,
              status: PaymentStatus.Settled,
              idempotency_key: paymentKey,
            },
            t,
          );
        }
      }

      // Append-only, balanced double-entry ledger:
      //   Dr wage expense (gross)  Cr cash (net) + tax liability + deduction liability.
      const totalGross = totalNet + totalTax + totalDeductions;
      await this.repo.appendLedgerEntry(
        {
          tenant_id: tenantId,
          pay_run_id: run.id,
          account: LedgerAccount.WageExpense,
          debit: totalGross,
          credit: 0,
          currency: runCurrency,
        },
        t,
      );
      await this.repo.appendLedgerEntry(
        {
          tenant_id: tenantId,
          pay_run_id: run.id,
          account: LedgerAccount.Cash,
          debit: 0,
          credit: totalNet,
          currency: runCurrency,
        },
        t,
      );
      await this.repo.appendLedgerEntry(
        {
          tenant_id: tenantId,
          pay_run_id: run.id,
          account: LedgerAccount.TaxLiability,
          debit: 0,
          credit: totalTax,
          currency: runCurrency,
        },
        t,
      );
      await this.repo.appendLedgerEntry(
        {
          tenant_id: tenantId,
          pay_run_id: run.id,
          account: LedgerAccount.DeductionLiability,
          debit: 0,
          credit: totalDeductions,
          currency: runCurrency,
        },
        t,
      );

      // Version-checked disburse (W5-07): a second disburse that passed `assertStatus(Approved)`
      // concurrently can't also flip the run to Paid — its stale-version update matches zero rows.
      const updated = await this.repo.updatePayRunVersioned(
        run.id,
        run.lock_version ?? 0,
        { status: PayRunStatus.Paid },
        t,
      );

      // W5-13 — record disbursement on the shared timeline (same RLS tx, before the ERP event).
      await this.writeActivity(
        run.id,
        RequestContext.userId() ?? null,
        'disbursed',
        {
          from: PayRunStatus.Approved,
          to: PayRunStatus.Paid,
          currency: runCurrency,
          batchId: batch.id,
        },
        t,
      );

      // ERP GL push — header-level summary only (NO employee PII, NO net pay). REQUESTED as an event
      // instead of pushed inline (W2-07): a slow/failing ERP no longer blocks disbursement, and the
      // push is retried by the ERP-sync consumer. Staged in the SAME tx (transactional outbox) so it
      // commits atomically with the Paid transition and is drained to the bus at-least-once.
      // idempotencyKey = run id + summary hash → the consumer pushes at most once even on redelivery.
      const summary = await this.repo.glSummaryForRun(run.id, t);
      const idemHash = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
      await stageOutboxEvent(
        makeEnvelope(EventTopic.ConnectorPushRequested, {
          connectorKind: ConnectorKind.LedgerOne,
          entity: ConnectorEntity.PayrollJournal,
          idempotencyKey: `${run.id}:${idemHash}`,
          recordType: 'pay_run',
          recordId: run.id,
          data: { payRunId: run.id, lines: summary },
          ruleId: 'payroll.disburse',
        }),
        t,
      );

      return this.toDto(updated);
    });
  }

  // ---- helpers ----

  private async loadOrThrow(id: string, t: Transaction): Promise<PayrollShape.PayRunRow> {
    const run = await this.repo.findPayRunById(id, t);
    if (!run) throw ErrUtils.notFound('Pay run not found');
    return run;
  }

  private assertStatus(run: PayrollShape.PayRunRow, expected: PayRunStatus): void {
    if (run.status !== expected) {
      throw ErrUtils.conflict(`Pay run is '${run.status}', expected '${expected}'`);
    }
  }

  /**
   * Ledger postings for a run are single-currency: every payslip must share one currency so the
   * balanced double-entry never mixes currencies in a single set of totals (W5-09). Returns the
   * single run currency (falling back to USD only when a run has no payslips at all).
   */
  private assertSingleCurrency(payslips: PayrollShape.PayslipRow[]): string {
    const currencies = new Set(payslips.map((p) => p.currency).filter(Boolean));
    if (currencies.size > 1) {
      throw ErrUtils.validation(
        `Pay run mixes currencies (${[...currencies].join(', ')}); ledger postings require a single currency per run`,
      );
    }
    return currencies.size === 1 ? [...currencies][0] : 'USD';
  }

  private requireUser(): string {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');
    return userId;
  }

  /**
   * Append to the SHARED, polymorphic business timeline (@aegis/activity), keyed by the same
   * `(pay_run, runId)` the approval engine uses — one cross-service who-did-what feed at approve/reject
   * (the reusable pattern expense/invoice copy). Always called within the active RLS-scoped tx.
   */
  private async writeActivity(
    payRunId: string,
    actorId: string | null,
    action: string,
    details: Record<string, unknown>,
    t: Transaction,
  ): Promise<void> {
    await ActivityLogger.record(
      { recordType: ApprovalRecordType.PayRun, recordId: payRunId, action, actorId, details },
      t,
    );
  }

  private toDto(run: PayrollShape.PayRunRow): PayrollShape.PayRunDto {
    return {
      id: run.id,
      status: run.status,
      type: run.type,
      periodStart: run.period_start,
      periodEnd: run.period_end,
      payDate: run.pay_date,
      createdBy: run.created_by,
      approvedBy: run.approved_by,
      teamId: run.team_id ?? null,
      assigneeId: run.assignee_id ?? null,
      tags: Array.isArray(run.tags) ? run.tags : [],
    };
  }

  private toPayslipDto(row: PayrollShape.PayslipRow): PayrollShape.PayslipDto {
    return {
      id: row.id,
      payRunId: row.pay_run_id,
      employeeId: row.employee_id,
      gross: Number(row.gross),
      taxableBase: Number(row.taxable_base),
      totalTax: Number(row.total_tax),
      totalDeductions: Number(row.total_deductions),
      currency: row.currency,
      status: row.status,
    };
  }
}
