import type { NotificationShape } from '@aegis/shared-types';

export const expenseRejectedTemplate: NotificationShape.MessageTemplate = {
  name: 'expense-rejected',
  subject: 'Expense report rejected',
  body: 'Your expense report {{reportId}} was rejected{{reasonSuffix}}.',
  html:
    '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">' +
    '<h1 style="font-size:18px;margin:0 0 12px">Expense report rejected</h1>' +
    '<p>Your expense report <strong>{{reportId}}</strong> was rejected{{reasonSuffix}}.</p>' +
    '</div>',
};
