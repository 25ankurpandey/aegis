import { NotificationCode } from '@aegis/shared-enums';
import type { NotificationShape } from '@aegis/shared-types';
import { render } from '../../src/services/content-map';

describe('content-map render', () => {
  it('renders an expense-approved message with formatted minor-unit money', () => {
    const message: NotificationShape.NotificationMessage = {
      code: NotificationCode.ExpenseApproved,
      reportId: 'rpt-1',
      approvedBy: 'mgr-1',
      amountMinor: 12345,
    };
    const content = render(message);
    expect(content.template).toBe('expense-approved');
    expect(content.subject).toBe('Expense report approved');
    expect(content.body).toContain('rpt-1');
    expect(content.body).toContain('123.45');
    expect(content.html).toContain('<strong>rpt-1</strong>');
    expect(content.html).toContain('<strong>123.45</strong>');
  });

  it('renders an invoice-approved message and includes the PO reference when present', () => {
    const message: NotificationShape.NotificationMessage = {
      code: NotificationCode.InvoiceApproved,
      invoiceId: 'inv-9',
      vendorName: 'Acme',
      amountMinor: 5000,
      poReference: 'PO-42',
    };
    const content = render(message);
    expect(content.template).toBe('invoice-approved');
    expect(content.subject).toContain('inv-9');
    expect(content.body).toContain('Acme');
    expect(content.body).toContain('50.00');
    expect(content.body).toContain('PO-42');
  });

  it('omits the PO reference from an invoice body when absent', () => {
    const message: NotificationShape.NotificationMessage = {
      code: NotificationCode.InvoiceApproved,
      invoiceId: 'inv-10',
      vendorName: 'Beta',
      amountMinor: 100,
    };
    const content = render(message);
    expect(content.body).not.toContain('PO');
  });

  it('formats a sub-dollar amount with a zero-padded cents component', () => {
    const message: NotificationShape.NotificationMessage = {
      code: NotificationCode.ExpenseApproved,
      reportId: 'rpt-2',
      approvedBy: 'mgr-2',
      amountMinor: 7,
    };
    expect(render(message).body).toContain('0.07');
  });

  it('renders an approval-requested message with a humanized subject type', () => {
    const message: NotificationShape.NotificationMessage = {
      code: NotificationCode.ApprovalRequested,
      approvalId: 'apr-1',
      subjectType: 'expense_report',
      subjectId: 'sub-1',
      requestedBy: 'req-1',
    };
    const content = render(message);
    expect(content.template).toBe('approval-requested');
    expect(content.subject).toContain('expense report');
    expect(content.body).toContain('sub-1');
  });

  it('renders a pay-run-approved message', () => {
    const message: NotificationShape.NotificationMessage = {
      code: NotificationCode.PayRunApproved,
      payRunId: 'run-1',
      approvedBy: 'fin-1',
    };
    const content = render(message);
    expect(content.template).toBe('pay-run-approved');
    expect(content.body).toContain('run-1');
  });
});
