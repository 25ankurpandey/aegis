import type { NotificationShape } from '@aegis/shared-types';

export const expenseApprovedTemplate: NotificationShape.MessageTemplate = {
  name: 'expense-approved',
  subject: 'Expense report approved',
  body: 'Your expense report {{reportId}} for {{amount}} was approved.',
  html:
    '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">' +
    '<h1 style="font-size:18px;margin:0 0 12px">Expense report approved</h1>' +
    '<p>Your expense report <strong>{{reportId}}</strong> for <strong>{{amount}}</strong> was approved.</p>' +
    '</div>',
};
