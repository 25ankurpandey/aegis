import { createHash } from 'node:crypto';
import { UniqueConstraintError, type Transaction } from 'sequelize';
import { inject } from 'inversify';
import { ErrUtils, FeatureFlags, RequestContext } from '@aegis/service-core';
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
import { AuditAction, AuditOutcome } from '@aegis/shared-enums';
import {
  InvoiceStatus,
  InvoiceActivityType,
  InvoiceTransactionType,
  ConnectorKind,
  ConnectorEntity,
  ApprovalRecordType,
  ApprovalDecision,
} from '@aegis/shared-enums';
import { InvoiceShape, type ApprovalShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { InvoiceRepository } from '../repositories/invoice.repository';

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

/** Header-level invoice lifecycle: receive → duplicate detect → validate → approve → ERP push. */
@provideSingleton(InvoiceService)
export class InvoiceService {
  constructor(
    @inject(InvoiceRepository) private readonly repo: InvoiceRepository,
    // The shared multi-level approval engine, injected via the reusable `registerApprovalProviders()`
    // wiring in `ioc/loader.ts` (the expense reference template). Tenant-scoped internally.
    @inject(ApprovalService) private readonly approvals: ApprovalService,
  ) {}

  /** Stable duplicate signature over (vendor + invoice_number + amount + currency). */
  private signature(
    vendorName: string,
    invoiceNumber: string,
    amountMinor: bigint,
    currency: string,
  ): string {
    const normalized = `${vendorName.trim().toUpperCase()}|${invoiceNumber.trim().toUpperCase()}|${amountMinor.toString()}|${currency.toUpperCase()}`;
    return createHash('sha256').update(normalized).digest('hex');
  }

  private toDto(row: InvoiceShape.InvoiceRow): InvoiceShape.InvoiceDto {
    return {
      id: row.id,
      status: row.status,
      vendorName: row.vendor_name,
      invoiceNumber: row.invoice_number,
      amountMinor: row.amount_minor,
      currency: row.currency,
      transactionType: row.transaction_type,
      autoApproved: row.auto_approved,
      teamId: row.team_id ?? null,
      assigneeId: row.assignee_id ?? null,
      tags: Array.isArray(row.tags) ? row.tags : [],
      createdAt: row.created_at,
    };
  }

  /**
   * Create a header → Received, then run header-level DUPLICATE DETECTION. On a signature
   * collision (same tenant + vendor + invoice_number + amount) the invoice is marked Duplicate
   * and an invoice_duplicates row is written; otherwise it advances Validating → PendingReview.
   *
   * CONCURRENCY (W5-06): the best-effort `findDuplicateCandidate` read can't see a sibling insert
   * that hasn't committed, so two concurrent submits of the same signature would both pass the read
   * and both go live. The `invoices_dup_signature_live_uq` partial-unique index (0017) closes that
   * race at the database: only ONE live, non-duplicate invoice may hold a signature, so the loser's
   * insert raises a unique violation. We catch it and deterministically re-create the loser as a
   * Duplicate linked to the winner — the no-double-pay guarantee then holds under concurrency, not
   * just on the read. The non-concurrent path is unchanged.
   */
  async create(input: InvoiceShape.CreateInvoiceInput): Promise<InvoiceShape.InvoiceDto> {
    try {
      return await withTenantTransaction((t) => this.insertAndDetect(input, t));
    } catch (err) {
      // The partial-unique dedup index fired: a sibling insert won the race between our read and our
      // write. Deterministically resolve THIS invoice as the duplicate (link to the live winner).
      if (this.isDedupViolation(err)) {
        return this.recordConcurrentDuplicate(input);
      }
      throw err;
    }
  }

  /**
   * The happy/serial create body: insert the header (Received) + metadata + activity, then run the
   * read-based duplicate detection. A signature collision visible to the read marks this invoice
   * Duplicate; otherwise it advances Validating → PendingReview. A collision NOT visible to the read
   * (a concurrent sibling) surfaces as a unique-violation from the insert/status write, caught by
   * {@link create}.
   */
  private async insertAndDetect(
    input: InvoiceShape.CreateInvoiceInput,
    t: Transaction,
  ): Promise<InvoiceShape.InvoiceDto> {
    const tenantId = RequestContext.tenantId();
    const userId = RequestContext.userId() ?? null;
    const correlationId = RequestContext.correlationId();
    const amount = BigInt(input.amountMinor);
    const txnType = input.transactionType ?? InvoiceTransactionType.Debit;

    const invoice = await this.repo.createInvoice(
      {
        tenant_id: tenantId,
        vendor_id: input.vendorId ?? null,
        vendor_name: input.vendorName,
        invoice_number: input.invoiceNumber,
        invoice_date: input.invoiceDate,
        due_date: input.dueDate ?? null,
        amount_minor: amount,
        currency: input.currency,
        transaction_type: txnType,
        status: InvoiceStatus.Received,
        created_by: userId,
      },
      t,
    );

    await this.repo.createMetadata(
      {
        tenant_id: tenantId,
        invoice_id: invoice.id,
        invoice_number: input.invoiceNumber,
        invoice_date: input.invoiceDate,
        due_date: input.dueDate ?? null,
        transaction_type: txnType,
        amount_minor: amount,
        currency: input.currency,
      },
      t,
    );

    await this.repo.recordActivity(
      {
        tenant_id: tenantId,
        invoice_id: invoice.id,
        user_id: userId,
        activity_type: InvoiceActivityType.Received,
        details: { status: InvoiceStatus.Received },
        correlation_id: correlationId,
      },
      t,
    );

    // --- duplicate detection ---
    const candidate = await this.repo.findDuplicateCandidate(
      {
        vendorName: input.vendorName,
        invoiceNumber: input.invoiceNumber,
        amountMinor: amount,
        currency: input.currency,
        excludeId: invoice.id,
      },
      t,
    );

    let finalStatus: InvoiceStatus;
    if (candidate) {
      finalStatus = InvoiceStatus.Duplicate;
      await this.repo.createDuplicate(
        {
          tenant_id: tenantId,
          invoice_id: invoice.id,
          duplicate_of: candidate.id,
          signature: this.signature(input.vendorName, input.invoiceNumber, amount, input.currency),
          reason: 'Matching vendor, invoice number and amount signature',
        },
        t,
      );
      await this.repo.updateStatus(invoice.id, { status: finalStatus }, t);
      await this.repo.recordActivity(
        {
          tenant_id: tenantId,
          invoice_id: invoice.id,
          user_id: userId,
          activity_type: InvoiceActivityType.DuplicateFlagged,
          details: { duplicate_of: candidate.id },
          correlation_id: correlationId,
        },
        t,
      );
    } else {
      // No collision: run validation then hold for human review/approval routing.
      finalStatus = InvoiceStatus.PendingReview;
      await this.repo.updateStatus(invoice.id, { status: InvoiceStatus.Validating }, t);
      await this.repo.updateStatus(invoice.id, { status: finalStatus }, t);
    }

    return this.toDto({ ...invoice, status: finalStatus });
  }

  /**
   * Recovery path for the concurrent-insert loser (W5-06): our first transaction was rolled back by
   * the partial-unique violation, so the header no longer exists. Re-create it in a fresh tx, but
   * born DIRECTLY as Duplicate (which the index predicate excludes, so this insert never collides),
   * link it to the live winner, and write the Received + DuplicateFlagged trail. If the winner has
   * since vanished (e.g. soft-deleted) the signature is free again, so we simply retry the normal
   * create once.
   */
  private async recordConcurrentDuplicate(
    input: InvoiceShape.CreateInvoiceInput,
  ): Promise<InvoiceShape.InvoiceDto> {
    const tenantId = RequestContext.tenantId();
    const userId = RequestContext.userId() ?? null;
    const correlationId = RequestContext.correlationId();
    const amount = BigInt(input.amountMinor);
    const txnType = input.transactionType ?? InvoiceTransactionType.Debit;

    return withTenantTransaction(async (t) => {
      const winner = await this.repo.findDuplicateCandidate(
        {
          vendorName: input.vendorName,
          invoiceNumber: input.invoiceNumber,
          amountMinor: amount,
          currency: input.currency,
        },
        t,
      );
      // Winner gone (freed signature) ⇒ no live collision anymore; run the normal create body.
      if (!winner) {
        return this.insertAndDetect(input, t);
      }

      const invoice = await this.repo.createInvoice(
        {
          tenant_id: tenantId,
          vendor_id: input.vendorId ?? null,
          vendor_name: input.vendorName,
          invoice_number: input.invoiceNumber,
          invoice_date: input.invoiceDate,
          due_date: input.dueDate ?? null,
          amount_minor: amount,
          currency: input.currency,
          transaction_type: txnType,
          // Born Duplicate: excluded from the partial-unique predicate, so this insert is collision-free.
          status: InvoiceStatus.Duplicate,
          created_by: userId,
        },
        t,
      );

      await this.repo.createMetadata(
        {
          tenant_id: tenantId,
          invoice_id: invoice.id,
          invoice_number: input.invoiceNumber,
          invoice_date: input.invoiceDate,
          due_date: input.dueDate ?? null,
          transaction_type: txnType,
          amount_minor: amount,
          currency: input.currency,
        },
        t,
      );

      await this.repo.recordActivity(
        {
          tenant_id: tenantId,
          invoice_id: invoice.id,
          user_id: userId,
          activity_type: InvoiceActivityType.Received,
          details: { status: InvoiceStatus.Received },
          correlation_id: correlationId,
        },
        t,
      );

      await this.repo.createDuplicate(
        {
          tenant_id: tenantId,
          invoice_id: invoice.id,
          duplicate_of: winner.id,
          signature: this.signature(input.vendorName, input.invoiceNumber, amount, input.currency),
          reason: 'Concurrent submit of an existing live invoice signature',
        },
        t,
      );

      await this.repo.recordActivity(
        {
          tenant_id: tenantId,
          invoice_id: invoice.id,
          user_id: userId,
          activity_type: InvoiceActivityType.DuplicateFlagged,
          details: { duplicate_of: winner.id, concurrent: true },
          correlation_id: correlationId,
        },
        t,
      );

      return this.toDto({ ...invoice, status: InvoiceStatus.Duplicate });
    });
  }

  /**
   * True when `err` is the dedup partial-unique violation — the marker that a concurrent sibling won
   * the live-invoice signature. We match on our index name so an unrelated unique violation (e.g. a
   * future constraint) still propagates as a real error. BUG-0010 renamed the index to the
   * currency-inclusive `invoices_dup_signature_cur_live_uq`; the old currency-less
   * `invoices_dup_signature_live_uq` is still accepted for in-flight rows during the migration window.
   */
  private isDedupViolation(err: unknown): boolean {
    if (!(err instanceof UniqueConstraintError)) return false;
    const names = new Set(['invoices_dup_signature_cur_live_uq', 'invoices_dup_signature_live_uq']);
    const indexName = (err as { index?: string }).index;
    if (indexName && names.has(indexName)) return true;
    // Fallbacks for drivers that surface the constraint name on the original PG error instead of `index`.
    const constraint = (err.original as { constraint?: string } | undefined)?.constraint;
    if (constraint && names.has(constraint)) return true;
    return err.errors?.some((e) => typeof e.path === 'string' && names.has(e.path)) ?? false;
  }

  async list(
    filter: InvoiceShape.InvoiceListFilter,
    page: number,
    pageSize: number,
  ): Promise<InvoiceShape.InvoiceListResult> {
    return withTenantTransaction(async (t) => {
      const { rows, total } = await this.repo.list(filter, page, pageSize, t);
      return { data: rows.map((r) => this.toDto(r)), meta: { total, page, pageSize } };
    });
  }

  async getById(id: string): Promise<InvoiceShape.InvoiceDto> {
    return withTenantTransaction(async (t) => {
      const row = await this.repo.findById(id, t);
      if (!row) throw ErrUtils.notFound('Invoice not found');
      return this.toDto(row);
    });
  }

  /**
   * Route a validated invoice into the shared approval engine → ForApproval, emit invoice.received.
   *
   * Moves the invoice into its pending-approval status, records a Received activity (+ shared
   * {@link ActivityLogger} timeline) + the invoice.received event, then calls
   * `ApprovalService.requestApproval` keyed by `(Invoice, invoiceId)` with the invoice amount +
   * currency + submitter, so the engine resolves the tenant's policy and materialises the approver
   * chain (emitting ApprovalRequested → notifications fan out). The engine call is idempotent, so a
   * re-submit never double-routes. If the resolved chain is EMPTY (no policy / SoD excluded everyone),
   * the engine auto-completes as approved — we honour that immediately by advancing the invoice
   * straight to Approved (the same path `decide` takes on completion).
   */
  async submit(id: string): Promise<InvoiceShape.InvoiceDto> {
    const tenantId = RequestContext.tenantId();
    const userId = RequestContext.userId() ?? null;
    const correlationId = RequestContext.correlationId();

    const submitted = await withTenantTransaction(async (t) => {
      const row = await this.repo.findById(id, t);
      if (!row) throw ErrUtils.notFound('Invoice not found');
      if (![InvoiceStatus.Validating, InvoiceStatus.PendingReview].includes(row.status)) {
        throw ErrUtils.conflict(`Cannot submit an invoice in status '${row.status}'`, {
          from: row.status,
          attempted: InvoiceStatus.ForApproval,
        });
      }
      // Version-checked transition: pass the version observed at the status gate so a concurrent
      // submit on the same invoice can't also pass the gate and double-route (W5-07).
      await this.repo.updateStatus(
        id,
        { status: InvoiceStatus.ForApproval, submitted_by: userId ?? undefined },
        t,
        row.lock_version,
      );
      await this.writeActivity(
        id,
        userId,
        InvoiceActivityType.Received,
        { status: InvoiceStatus.ForApproval },
        correlationId,
        t,
      );
      // Stage the domain event in the SAME tx (transactional outbox): persisted atomically with the
      // status write, drained to the bus at-least-once by the relay — no post-commit dual-write window.
      await stageOutboxEvent(
        makeEnvelope(EventTopic.InvoiceReceived, {
          invoiceId: id,
          status: InvoiceStatus.ForApproval,
          submitterId: userId ?? undefined,
        }),
        t,
      );
      return { ...row, status: InvoiceStatus.ForApproval } as InvoiceShape.InvoiceRow;
    });

    // Materialise the approver chain via the shared engine (its own tenant tx). Idempotent: a
    // re-submit returns the existing chain rather than re-routing. requestedBy is the submitter (the
    // SoD requester), falling back to the creator when the invoice was routed without an authed user.
    const requestedBy = submitted.submitted_by ?? submitted.created_by ?? userId ?? tenantId;
    const chain = await this.approvals.requestApproval({
      recordType: ApprovalRecordType.Invoice,
      recordId: id,
      // BUG-0007: pass the BIGINT minor-unit amount straight through (the engine accepts bigint|string),
      // so amounts beyond Number.MAX_SAFE_INTEGER route to the correct threshold level. No Number().
      amountMinor: submitted.amount_minor,
      currency: submitted.currency,
      requestedBy,
    });

    // Empty chain ⇒ the engine auto-completed (no required approvers). Advance straight to Approved
    // so the invoice never stalls in ForApproval with nobody to act.
    if (chain.chain.length === 0) {
      return this.applyCompletion(id, 'approved', requestedBy);
    }

    return this.toDto(submitted);
  }

  /**
   * Record one approver's decision on an invoice through the shared approval engine, then advance the
   * invoice when the chain completes — the engine-backed replacement for the old single-shot
   * `approve`. Guarded by the invoice `approve` permission at the controller.
   *
   * Flow: `ApprovalService.decide({ Invoice, invoiceId, approverId, decision, comment })` appends the
   * immutable vote and advances/short-circuits the chain (the engine enforces no-double-vote and that
   * the principal is a PENDING approver — a non-approver gets a 403 from the engine). When the chain
   * reports COMPLETED we advance the invoice status IN PROCESS here (approved→Approved + the existing
   * ConnectorPushRequested/InvoiceApproved staging; rejected→Rejected) via {@link applyCompletion};
   * until then the invoice stays in ForApproval. The status advance is idempotent (an invoice already
   * in the terminal state is a no-op), so a replayed completion / re-issued decide is again-safe.
   */
  async decide(id: string, input: InvoiceShape.DecideInput): Promise<InvoiceShape.InvoiceDto> {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');

    // Pre-flight: the invoice must exist (404) and be ForApproval (else the decision is moot). RLS
    // scopes the read; an invisible invoice yields the standard 404.
    const row = await withTenantTransaction((t) => this.repo.findById(id, t));
    if (!row) throw ErrUtils.notFound('Invoice not found');
    if (row.status !== InvoiceStatus.ForApproval) {
      throw ErrUtils.conflict(`Cannot approve an invoice in status '${row.status}'`, {
        from: row.status,
        attempted: InvoiceStatus.Approved,
      });
    }

    // BUG-0005 SELF-HEAL: if the engine chain is ALREADY terminal but the invoice is still stranded in
    // ForApproval (the in-request advance failed after the vote committed), don't re-vote — the engine
    // would 409 "already decided". Drive the idempotent completion straight from the staged outcome
    // instead, recovering the stranded record on the next decide attempt.
    const status = await this.approvals.getStatus(ApprovalRecordType.Invoice, id);
    if (status?.completed && status.outcome) {
      return this.applyCompletion(id, status.outcome, userId);
    }

    const decision =
      input.decision === 'rejected' ? ApprovalDecision.Rejected : ApprovalDecision.Approved;

    // Drive the engine (its own tenant tx): records the vote, advances/short-circuits the chain, and
    // stages ApprovalCompleted on a terminal state. Throws forbidden for a non-approver, conflict for
    // a double vote — both surface to the caller unchanged.
    const result = await this.approvals.decide({
      recordType: ApprovalRecordType.Invoice,
      recordId: id,
      approverId: userId,
      decision,
      comment: input.comment,
    });

    // Mirror each recorded vote onto the invoice's own decision ledger + timeline so the existing
    // invoice_approvals / activity feed stays populated (the engine owns the chain; invoice owns the
    // record). Level comes from the slot the approver just cleared.
    await this.recordDecisionTrail(id, userId, decision, input.comment, result);

    // In-process ApprovalCompleted handling (no worker): on a terminal chain, advance the invoice.
    if (result.completed && result.outcome) {
      return this.applyCompletion(id, result.outcome, userId);
    }

    // Chain still open: invoice remains in ForApproval.
    return withTenantTransaction(async (t) => {
      const fresh = (await this.repo.findById(id, t)) as InvoiceShape.InvoiceRow;
      return this.toDto(fresh);
    });
  }

  /**
   * Backward-compatible engine-backed alias for the removed single-shot approve: a POST /approve maps
   * to a `decide({ decision: 'approved' })` through the shared engine.
   */
  async approve(id: string, input: InvoiceShape.ApproveInput): Promise<InvoiceShape.InvoiceDto> {
    return this.decide(id, { decision: 'approved', comment: input.comment });
  }

  /**
   * The current user's PENDING invoice approval slots — their "approvals inbox". Asks the shared
   * engine for the live, still-pending `record_approvers` slots this principal owns for
   * `ApprovalRecordType.Invoice`, then hydrates each with its invoice header (RLS-scoped) so the
   * caller gets actionable rows (vendor / number / amount), not bare slot ids.
   */
  async listPendingApprovals(): Promise<InvoiceShape.PendingApprovalDto[]> {
    const userId = RequestContext.userId();
    if (!userId) throw ErrUtils.unauthorized('Not authenticated');
    const slots = await this.approvals.listPendingForApprover(userId, ApprovalRecordType.Invoice);
    if (slots.length === 0) return [];
    return withTenantTransaction(async (t) => {
      const out: InvoiceShape.PendingApprovalDto[] = [];
      for (const slot of slots) {
        const invoice = await this.repo.findById(slot.record_id, t);
        if (!invoice) continue; // RLS-invisible / deleted ⇒ drop from the inbox
        out.push({ invoiceId: invoice.id, level: slot.level, invoice: this.toDto(invoice) });
      }
      return out;
    });
  }

  /**
   * BUG-0005 — event-driven recovery of a stranded invoice. The per-service ApprovalCompleted consumer
   * (worker role) calls this when it relays a (possibly re-delivered) ApprovalCompleted: it drives the
   * SAME idempotent {@link applyCompletion} the in-request path uses, so a stranded invoice (vote
   * committed but the in-request advance failed) is advanced from the staged event, and a double
   * delivery is a no-op (applyCompletion returns the already-terminal invoice unchanged).
   */
  async applyCompletionFromEvent(
    id: string,
    outcome: ApprovalShape.ChainOutcome,
    decidedBy: string,
  ): Promise<void> {
    await this.applyCompletion(id, outcome, decidedBy);
  }

  /**
   * BUG-0003 — apply a workflow `assign_team` / `add_tag` rule action to the record it targets, under
   * the tenant context the bus rebuilt from the envelope. SETs the owning team and UNIONs the
   * classification tags (distinct), then records a `record_updated` shared-timeline entry. Idempotent
   * + again-safe: re-applying the same team/tags is a no-op, so an at-least-once redelivery changes
   * nothing.
   */
  async applyRecordUpdate(
    id: string,
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
      const row = await this.repo.findById(id, t);
      if (!row) throw ErrUtils.notFound('Invoice not found');
      let tagCache: string[] | undefined;
      if (update.tags && update.tags.length > 0) {
        tagCache = (
          await attachRecordTags({
            recordType: ApprovalRecordType.Invoice,
            recordId: id,
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
            recordType: ApprovalRecordType.Invoice,
            recordId: id,
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

      await this.repo.applyLabels(id, patch.write, t);
      await ActivityLogger.record(
        {
          recordType: ApprovalRecordType.Invoice,
          recordId: id,
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
   * Apply a completed approval chain to the invoice (the in-process ApprovalCompleted handler).
   * `approved` → Approved (+ ConnectorPushRequested/InvoiceApproved outbox staging); `rejected` →
   * Rejected. Idempotent + again-safe: if the invoice is already in the target terminal state we
   * return it unchanged (a replayed completion is a no-op), which keeps both the engine-driven
   * `decide` path and any future event-relay handler safe to call more than once.
   */
  private async applyCompletion(
    id: string,
    outcome: ApprovalShape.ChainOutcome,
    decidedBy: string,
  ): Promise<InvoiceShape.InvoiceDto> {
    const correlationId = RequestContext.correlationId();
    const target = outcome === 'approved' ? InvoiceStatus.Approved : InvoiceStatus.Rejected;

    return withTenantTransaction(async (t) => {
      const row = await this.repo.findById(id, t);
      if (!row) throw ErrUtils.notFound('Invoice not found');

      // Idempotency: already in the terminal state ⇒ no-op (again-safe completion).
      if (row.status === target) return this.toDto(row);

      // Version-checked transition: two concurrent chain completions can't both clobber the invoice
      // status — the stale one fails the lock_version guard with a 409 (W5-07).
      await this.repo.updateStatus(id, { status: target }, t, row.lock_version);
      await this.writeActivity(
        id,
        decidedBy,
        outcome === 'approved' ? InvoiceActivityType.Approved : InvoiceActivityType.Rejected,
        { from: row.status, to: target, via: 'approval_engine' },
        correlationId,
        t,
      );

      await AuditLogger.record(
        {
          action: AuditAction.StateTransition,
          outcome: AuditOutcome.Success,
          resourceType: 'invoice',
          resourceId: id,
          details: { to: target },
        },
        t,
      );

      // A rejected invoice never reaches the ledger — no event/ERP push.
      if (outcome !== 'approved') {
        return this.toDto({ ...row, status: target });
      }

      const approved: InvoiceShape.InvoiceRow = { ...row, status: InvoiceStatus.Approved };
      const erpData: Record<string, unknown> = {
        invoiceId: approved.id,
        vendorName: approved.vendor_name,
        invoiceNumber: approved.invoice_number,
        invoiceDate: approved.invoice_date,
        dueDate: approved.due_date,
        amountMinor: approved.amount_minor,
        currency: approved.currency,
        transactionType: approved.transaction_type,
      };
      // Recipient hint: notify whoever routed the invoice (submitter, else creator).
      const recipientUserId = approved.submitted_by ?? approved.created_by ?? decidedBy;

      // Stage the domain event in the SAME tx as the status write (transactional outbox): it commits
      // atomically with the approval and is drained to the bus at-least-once by the relay. One typed
      // payload (the shared contract): tenant comes from the envelope; payload carries the hint + facts.
      await stageOutboxEvent(
        makeEnvelope(EventTopic.InvoiceApproved, {
          invoiceId: id,
          status: InvoiceStatus.Approved,
          vendorName: approved.vendor_name,
          amountMinor: Number(approved.amount_minor), // header-level integer minor units
          poReference: approved.invoice_number,
          recipientUserId,
        }),
        t,
      );

      // Request the ERP push as an EVENT instead of calling the connector inline (W2-07): a slow or
      // failing ERP no longer blocks the request, and the push is retried by the consumer. Staged in
      // the SAME tx (outbox) so it commits atomically with the approval and is never lost.
      // idempotencyKey = invoice id → the ERP-sync consumer pushes at most once even on redelivery.
      await stageOutboxEvent(
        makeEnvelope(EventTopic.ConnectorPushRequested, {
          connectorKind: ConnectorKind.LedgerOne,
          entity: ConnectorEntity.Invoice,
          idempotencyKey: id,
          recordType: 'invoice',
          recordId: id,
          data: erpData,
          ruleId: 'invoice.approve',
        }),
        t,
      );

      return this.toDto(approved);
    });
  }

  /**
   * Mirror an engine-recorded vote onto the invoice's own `invoice_approvals` ledger + activity feed.
   * The shared engine owns the authoritative chain/vote; invoice keeps its per-record decision rows
   * (and timeline) populated for the detail view. The level is the slot the approver cleared.
   */
  private async recordDecisionTrail(
    id: string,
    approverId: string,
    decision: ApprovalDecision,
    comment: string | undefined,
    result: ApprovalShape.DecisionResult,
  ): Promise<void> {
    const tenantId = RequestContext.tenantId();
    const correlationId = RequestContext.correlationId();
    const slot = result.chain.find((r) => r.approver_id === approverId);
    const level = slot?.level ?? 1;
    const decisionLabel = decision === ApprovalDecision.Approved ? 'approved' : 'rejected';
    await withTenantTransaction(async (t) => {
      await this.repo.createApproval(
        {
          tenant_id: tenantId,
          invoice_id: id,
          approver_id: approverId,
          approval_level: level,
          decision: decisionLabel,
          comment: comment ?? null,
        },
        t,
      );
      await this.writeActivity(
        id,
        approverId,
        decision === ApprovalDecision.Approved
          ? InvoiceActivityType.Approved
          : InvoiceActivityType.Rejected,
        { decision: decisionLabel, comment: comment ?? null, level },
        correlationId,
        t,
      );
    });
  }

  /**
   * Append a per-invoice activity row AND mirror it onto the SHARED, polymorphic business timeline
   * (@aegis/activity), keyed by the same `(invoice, invoiceId)` the approval engine uses — one
   * cross-service who-did-what feed (the expense reference template). Same RLS tx.
   */
  private async writeActivity(
    id: string,
    userId: string | null,
    activityType: InvoiceActivityType,
    details: Record<string, unknown>,
    correlationId: string | undefined,
    t: Transaction,
  ): Promise<void> {
    await this.repo.recordActivity(
      {
        tenant_id: RequestContext.tenantId(),
        invoice_id: id,
        user_id: userId,
        activity_type: activityType,
        details,
        correlation_id: correlationId ?? null,
      },
      t,
    );
    await ActivityLogger.record(
      {
        recordType: ApprovalRecordType.Invoice,
        recordId: id,
        action: activityType,
        actorId: userId,
        details,
      },
      t,
    );
  }
}
