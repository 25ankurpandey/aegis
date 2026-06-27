import type { NotificationShape } from '@aegis/shared-types';
import { approvalRequestedTemplate } from './approval-requested.template';
import { expenseApprovedTemplate } from './expense-approved.template';
import { expenseRejectedTemplate } from './expense-rejected.template';
import { invoiceApprovedTemplate } from './invoice-approved.template';
import { payRunApprovedTemplate } from './pay-run-approved.template';
import { ruleNoticeTemplate } from './rule-notice.template';

/**
 * Versioned mail template catalog. Each template carries text and HTML so the in-app inbox, SMS,
 * and email provider all render from the same named template id while email gets a rich body.
 */
export const MAIL_TEMPLATES: readonly NotificationShape.MessageTemplate[] = [
  expenseApprovedTemplate,
  expenseRejectedTemplate,
  invoiceApprovedTemplate,
  approvalRequestedTemplate,
  payRunApprovedTemplate,
  ruleNoticeTemplate,
];
