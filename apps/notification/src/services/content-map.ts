import { NotificationCode } from '@aegis/shared-enums';
import type { NotificationShape } from '@aegis/shared-types';
import { TemplateEngine } from './template-engine';
import { MAIL_TEMPLATES } from '../templates/mail-templates';

/** Minor-unit money → human string (no locale dependency; integer minor units, SPEC §9). */
function formatMoney(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export const templateEngine = new TemplateEngine(MAIL_TEMPLATES);

type VarBuilder<C extends NotificationCode> = (
  m: Extract<NotificationShape.NotificationMessage, { code: C }>,
) => { template: string; vars: NotificationShape.TemplateVars };

/**
 * One variable-builder per consumed code — typed as a total map over the union, so adding a handled
 * NotificationCode without a builder is a compile-time break (no silent empty send). Each returns the
 * template name to render + the interpolation variables for it.
 */
const VAR_BUILDERS: { [C in NotificationShape.NotificationMessage['code']]: VarBuilder<C> } = {
  [NotificationCode.ExpenseApproved]: (m) => ({
    template: 'expense-approved',
    vars: { reportId: m.reportId, amount: formatMoney(m.amountMinor) },
  }),
  [NotificationCode.ExpenseRejected]: (m) => ({
    template: 'expense-rejected',
    vars: { reportId: m.reportId, reasonSuffix: m.reason ? `: ${m.reason}` : '' },
  }),
  [NotificationCode.InvoiceApproved]: (m) => ({
    template: 'invoice-approved',
    vars: {
      invoiceId: m.invoiceId,
      vendorName: m.vendorName,
      amount: formatMoney(m.amountMinor),
      poSuffix: m.poReference ? ` (PO ${m.poReference})` : '',
    },
  }),
  [NotificationCode.ApprovalRequested]: (m) => ({
    template: 'approval-requested',
    vars: {
      subjectLabel: m.subjectType.replace('_', ' '),
      subjectType: m.subjectType,
      subjectId: m.subjectId,
    },
  }),
  [NotificationCode.PayRunApproved]: (m) => ({
    template: 'pay-run-approved',
    vars: { payRunId: m.payRunId },
  }),
  [NotificationCode.RuleNotice]: (m) => ({
    template: 'rule-notice',
    vars: {
      template: m.template,
      ruleId: String(m.context['ruleId'] ?? ''),
      recordType: String(m.context['recordType'] ?? ''),
      recordId: String(m.context['recordId'] ?? ''),
    },
  }),
};

export function render(message: NotificationShape.NotificationMessage): NotificationShape.RenderedContent {
  const build = VAR_BUILDERS[message.code] as VarBuilder<NotificationShape.NotificationMessage['code']>;
  const { template, vars } = build(message);
  return templateEngine.render(template, vars);
}
