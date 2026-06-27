import type {
  InvoiceStatus,
  InvoiceTransactionType,
  InvoiceActivityType,
  InvoiceDuplicateStatus,
} from '@aegis/shared-enums';

/**
 * Domain contract for the invoice service (header-level invoice lifecycle: receive → duplicate
 * detect → validate → approve → ERP push). Service-local DTOs, repository row shapes, and the
 * service method inputs all live here (SPEC §11.2 — no domain types defined inside the service).
 * Controllers, services, and repositories import these from `@aegis/shared-types`.
 */
export namespace InvoiceShape {
  // ---- Persistence row shapes (what repositories return; `*.get({ plain: true })`) ----

  /** A row of the `invoices` table (the aggregate root; money as a BIGINT string). */
  export interface InvoiceRow {
    id: string;
    tenant_id: string;
    vendor_id: string | null;
    vendor_name: string;
    invoice_number: string;
    invoice_date: string;
    due_date: string | null;
    amount_minor: string;
    currency: string;
    transaction_type: InvoiceTransactionType;
    status: InvoiceStatus;
    auto_approved: boolean;
    auto_approved_by: string | null;
    approval_policy_id: string | null;
    submitted_by: string | null;
    created_by: string | null;
    /** Owning team set by a workflow `assign_team` rule action (via the RecordUpdated follow-on). */
    team_id?: string | null;
    /** Current assignee/owner set by a workflow/manual assignment (via the RecordUpdated follow-on). */
    assignee_id?: string | null;
    /** Classification tags attached by a workflow `add_tag` rule action (unioned, distinct). */
    tags?: string[] | null;
    /**
     * Optimistic-lock counter (Sequelize `version: 'lock_version'`). Incremented on every persisted
     * status transition; carried into version-checked updates so two concurrent approvers can't both
     * pass `assertStatus` and clobber each other (W5-07).
     */
    lock_version: number;
    created_at: Date;
    updated_at: Date;
  }

  /** A row of the `invoice_metadata` table (1:1 with an invoice). */
  export interface InvoiceMetadataRow {
    id: string;
    tenant_id: string;
    invoice_id: string;
    invoice_number: string;
    invoice_date: string;
    due_date: string | null;
    transaction_type: InvoiceTransactionType;
    amount_minor: string;
    currency: string;
  }

  /** A row of the `invoice_duplicates` table. */
  export interface InvoiceDuplicateRow {
    id: string;
    tenant_id: string;
    invoice_id: string;
    duplicate_of: string;
    signature: string;
    reason: string | null;
    status: InvoiceDuplicateStatus;
    resolved_by: string | null;
  }

  /** A row of the `invoice_approvals` table. */
  export interface InvoiceApprovalRow {
    id: string;
    tenant_id: string;
    invoice_id: string;
    approver_id: string;
    approval_level: number;
    decision: string;
    comment: string | null;
    active: boolean;
  }

  /** A row of the append-only `invoice_activities` table. */
  export interface InvoiceActivityRow {
    id: string;
    tenant_id: string;
    invoice_id: string;
    user_id: string | null;
    activity_type: InvoiceActivityType;
    details: Record<string, unknown>;
    correlation_id: string | null;
    created_at: Date;
  }

  // ---- Repository write inputs ----

  /** Input to create an `invoices` row (money passed as a bigint, persisted as a BIGINT string). */
  export interface NewInvoice {
    tenant_id: string;
    vendor_id: string | null;
    vendor_name: string;
    invoice_number: string;
    invoice_date: string;
    due_date: string | null;
    amount_minor: bigint;
    currency: string;
    transaction_type: InvoiceTransactionType;
    status: InvoiceStatus;
    created_by: string | null;
  }

  /** Input to create an `invoice_metadata` row (money passed as a bigint). */
  export type NewInvoiceMetadata = Omit<InvoiceMetadataRow, 'id' | 'amount_minor'> & {
    amount_minor: bigint;
  };

  /** Input to create an `invoice_duplicates` row (status defaults to `flagged`). */
  export interface NewInvoiceDuplicate {
    tenant_id: string;
    invoice_id: string;
    duplicate_of: string;
    signature: string;
    reason: string | null;
  }

  /** Input to create an `invoice_approvals` row (`active` defaults to true). */
  export interface NewInvoiceApproval {
    tenant_id: string;
    invoice_id: string;
    approver_id: string;
    approval_level: number;
    decision: string;
    comment: string | null;
  }

  /** Input to append an `invoice_activities` row. */
  export interface NewInvoiceActivity {
    tenant_id: string;
    invoice_id: string;
    user_id: string | null;
    activity_type: InvoiceActivityType;
    details: Record<string, unknown>;
    correlation_id: string | null;
  }

  /** Filter for `InvoiceRepository.list` / `InvoiceService.list`. */
  export interface InvoiceListFilter {
    status?: InvoiceStatus;
    statuses?: string[];
    vendorId?: string;
    tagIds?: string[];
    tagIncludeNone?: boolean;
    tagMatch?: 'any' | 'all' | 'none';
    teamIds?: string[];
    teamIncludeNone?: boolean;
    assigneeIds?: string[];
    assigneeIncludeNone?: boolean;
  }

  /** Input to `InvoiceRepository.findDuplicateCandidate`. */
  export interface DuplicateCandidateInput {
    vendorName: string;
    invoiceNumber: string;
    amountMinor: bigint;
    /**
     * ISO currency code — part of the dedup signature (BUG-0010). The signature in
     * `InvoiceService.signature` already hashes currency, but the enforcement read + index omitted it,
     * so a legitimate same-vendor/number/amount invoice in a DIFFERENT currency was wrongly flagged as
     * a duplicate and never paid. Including currency here makes the read agree with the signature.
     */
    currency: string;
    /**
     * The just-inserted row to exclude from the self-join. Omitted by the concurrent-duplicate
     * recovery path (W5-06), which has no own row yet — it looks for the live winner directly.
     */
    excludeId?: string;
  }

  // ---- Service inputs (the public method args) ----

  /** Args to `InvoiceService.create`. */
  export interface CreateInvoiceInput {
    vendorId?: string;
    vendorName: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate?: string;
    transactionType?: InvoiceTransactionType;
    amountMinor: number;
    currency: string;
  }

  /** Args to `InvoiceService.approve`. */
  export interface ApproveInput {
    comment?: string;
    approvalLevel?: number;
  }

  /**
   * Args to `InvoiceService.decide` — one approver's vote on a `ForApproval` invoice through the
   * shared approval engine. The required terminal `decision` plus an optional comment recorded on the
   * vote and mirrored onto the invoice's own `invoice_approvals` ledger.
   */
  export interface DecideInput {
    decision: 'approved' | 'rejected';
    comment?: string;
  }

  // ---- Service result DTOs (the explicit response shapes) ----

  /** The header-level invoice projection returned to API callers. */
  export interface InvoiceDto {
    id: string;
    status: InvoiceStatus;
    vendorName: string;
    invoiceNumber: string;
    amountMinor: string;
    currency: string;
    transactionType: InvoiceTransactionType;
    autoApproved: boolean;
    teamId: string | null;
    assigneeId: string | null;
    tags: string[];
    createdAt: Date;
  }

  /** Result of `InvoiceService.list` — the page of invoices plus pagination meta. */
  export interface InvoiceListResult {
    data: InvoiceDto[];
    meta: { total: number; page: number; pageSize: number };
  }

  /**
   * One row of the current approver's pending-invoice inbox (`InvoiceService.listPendingApprovals`):
   * the still-pending engine slot's level paired with the hydrated invoice header it gates.
   */
  export interface PendingApprovalDto {
    invoiceId: string;
    level: number;
    invoice: InvoiceDto;
  }
}
