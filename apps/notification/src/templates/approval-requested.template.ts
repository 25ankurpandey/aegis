import type { NotificationShape } from '@aegis/shared-types';

export const approvalRequestedTemplate: NotificationShape.MessageTemplate = {
  name: 'approval-requested',
  subject: 'Approval requested: {{subjectLabel}}',
  body: 'You have a new {{subjectType}} ({{subjectId}}) awaiting your approval.',
  html:
    '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">' +
    '<h1 style="font-size:18px;margin:0 0 12px">Approval requested</h1>' +
    '<p>You have a new <strong>{{subjectLabel}}</strong> awaiting your approval.</p>' +
    '<p>Reference: <code>{{subjectId}}</code></p>' +
    '</div>',
};
