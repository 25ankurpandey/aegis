import type { NotificationShape } from '@aegis/shared-types';

export const ruleNoticeTemplate: NotificationShape.MessageTemplate = {
  name: 'rule-notice',
  subject: 'Notification: {{template}}',
  body: 'A workflow rule ({{ruleId}}) raised a notice for {{recordType}} {{recordId}}.',
  html:
    '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">' +
    '<h1 style="font-size:18px;margin:0 0 12px">Workflow notification</h1>' +
    '<p>A workflow rule (<strong>{{ruleId}}</strong>) raised a notice for ' +
    '<strong>{{recordType}}</strong> <code>{{recordId}}</code>.</p>' +
    '</div>',
};
