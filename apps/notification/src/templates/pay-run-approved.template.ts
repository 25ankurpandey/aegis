import type { NotificationShape } from '@aegis/shared-types';

export const payRunApprovedTemplate: NotificationShape.MessageTemplate = {
  name: 'pay-run-approved',
  subject: 'Pay run approved',
  body: 'Pay run {{payRunId}} has been approved and is ready for disbursement.',
  html:
    '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">' +
    '<h1 style="font-size:18px;margin:0 0 12px">Pay run approved</h1>' +
    '<p>Pay run <strong>{{payRunId}}</strong> has been approved and is ready for disbursement.</p>' +
    '</div>',
};
