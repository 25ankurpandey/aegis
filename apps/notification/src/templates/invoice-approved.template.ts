import type { NotificationShape } from '@aegis/shared-types';

export const invoiceApprovedTemplate: NotificationShape.MessageTemplate = {
  name: 'invoice-approved',
  subject: 'Invoice {{invoiceId}} approved',
  body: 'Invoice from {{vendorName}} for {{amount}}{{poSuffix}} has been approved.',
  html:
    '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">' +
    '<h1 style="font-size:18px;margin:0 0 12px">Invoice approved</h1>' +
    '<p>Invoice <strong>{{invoiceId}}</strong> from <strong>{{vendorName}}</strong> for ' +
    '<strong>{{amount}}</strong>{{poSuffix}} has been approved.</p>' +
    '</div>',
};
