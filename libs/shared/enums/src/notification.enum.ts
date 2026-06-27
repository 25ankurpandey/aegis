/** Notification enums. See docs/services/notification.md. */
export enum NotificationChannel {
  InApp = 'in_app',
  Email = 'email',
  Sms = 'sms',
}

/** Templated event codes (domain-namespaced). */
export enum NotificationCode {
  ExpenseSubmitted = 'expense/submitted',
  ExpenseApproved = 'expense/approved',
  ExpenseRejected = 'expense/rejected',
  InvoiceForApproval = 'invoice/for-approval',
  InvoiceApproved = 'invoice/approved',
  ApprovalRequested = 'approval/requested',
  PayRunApproved = 'payroll/run-approved',
  PaymentSettled = 'payroll/payment-settled',
  ReportReady = 'report/ready',
  /** Generic rule-authored notice (workflow `notify` action → NotificationRequested). BUG-0002. */
  RuleNotice = 'rule/notice',
}

/**
 * Terminal status vocabulary of the email ledger. `Failed` means a delivery was ATTEMPTED and the
 * transport errored (retryable / dead-lettered). The policy statuses below mean a send was
 * INTENTIONALLY NOT attempted — they are auditable as "not sent by design", distinct from a failure:
 *  - `Suppressed`: the recipient address is on the tenant suppression list (bounce/complaint/unsubscribe).
 *  - `Disabled`:   the tenant's email master-switch is off (tenant-wide email kill).
 *  - `Blocked`:    the recipient domain is denied (deny-list hit) or absent from a configured allow-list.
 */
export enum EmailNotificationStatus {
  Pending = 'pending',
  Sent = 'sent',
  Failed = 'failed',
  Suppressed = 'suppressed',
  Disabled = 'disabled',
  Blocked = 'blocked',
}

/** Reason an address landed on the tenant suppression list (drives the email_suppressions CHECK). */
export enum EmailSuppressionReason {
  Bounce = 'bounce',
  Complaint = 'complaint',
  Unsubscribe = 'unsubscribe',
}
