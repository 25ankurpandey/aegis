/**
 * Invoice lifecycle — HEADER-LEVEL only (no line items / no line-item matching / no GL codes).
 * "Matching" = duplicate detection + threshold/variance vs an optional PO reference + approval routing.
 * See docs/services/invoice.md.
 */
export enum InvoiceStatus {
  Received = 'received',
  Validating = 'validating',
  Duplicate = 'duplicate',
  PendingReview = 'pending_review',
  ForApproval = 'for_approval',
  Approved = 'approved',
  AutoApproved = 'auto_approved',
  Rejected = 'rejected',
  Cancelled = 'cancelled',
}

export const InvoiceStatusDisplay: Record<InvoiceStatus, string> = {
  [InvoiceStatus.Received]: 'Received',
  [InvoiceStatus.Validating]: 'Validating',
  [InvoiceStatus.Duplicate]: 'Duplicate',
  [InvoiceStatus.PendingReview]: 'Pending Review',
  [InvoiceStatus.ForApproval]: 'For Approval',
  [InvoiceStatus.Approved]: 'Approved',
  [InvoiceStatus.AutoApproved]: 'Auto-Approved',
  [InvoiceStatus.Rejected]: 'Rejected',
  [InvoiceStatus.Cancelled]: 'Cancelled',
};

export enum InvoiceTransactionType {
  Debit = 'debit',
  Credit = 'credit',
}

export enum InvoiceActivityType {
  Received = 'received',
  DuplicateFlagged = 'duplicate_flagged',
  Approved = 'approved',
  Rejected = 'rejected',
  Cancelled = 'cancelled',
}

/**
 * Lifecycle of a flagged duplicate-invoice record: a candidate is `flagged`, then either
 * `confirmed` (a true duplicate) / `dismissed` (a false positive) / `resolved` (handled).
 * Pins `invoice_duplicates.status`.
 */
export enum InvoiceDuplicateStatus {
  Flagged = 'flagged',
  Confirmed = 'confirmed',
  Dismissed = 'dismissed',
  Resolved = 'resolved',
}
