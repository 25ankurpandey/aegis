import { NotificationCode } from '@aegis/shared-enums';
import { EventTopic } from '@aegis/events';

/**
 * Notification domain constants (the architecture-donor Constants pattern, hoisted to
 * `@aegis/shared-constants` per SPEC §11.2). Per-code kill-switch lets ops globally disable a
 * NotificationCode during an incident without a deploy.
 */
export class NotificationConstants {
  /** Codes globally suppressed (empty by default — populated during an incident). */
  static readonly DisabledCodes: ReadonlySet<NotificationCode> = new Set<NotificationCode>();

  static isCodeEnabled(code: NotificationCode): boolean {
    return !NotificationConstants.DisabledCodes.has(code);
  }
}

/** Topic → NotificationCode mapping for the consumed, already-authorized domain events. */
export const TOPIC_TO_CODE: Partial<Record<EventTopic, NotificationCode>> = {
  [EventTopic.ExpenseApproved]: NotificationCode.ExpenseApproved,
  [EventTopic.InvoiceApproved]: NotificationCode.InvoiceApproved,
  [EventTopic.ApprovalRequested]: NotificationCode.ApprovalRequested,
  [EventTopic.PayRunApproved]: NotificationCode.PayRunApproved,
};
