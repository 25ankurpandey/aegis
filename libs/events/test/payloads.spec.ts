import { RequestContext } from '@aegis/service-core';
import { makeEnvelope, EventTopic, type EventEnvelope } from '../src/topics';
import type {
  ExpenseApprovedPayload,
  InvoiceApprovedPayload,
  PayRunApprovedPayload,
  ApprovalRequestedPayload,
  ApprovalCommandPayload,
} from '../src/payloads';

/**
 * The contract test: a producer payload built through makeEnvelope must satisfy the SAME typed
 * payload the consumer reads (one shared contract), the tenant must live on the ENVELOPE (not the
 * payload), and the notification-bound payloads must carry a recipient hint. These are the exact
 * properties whose absence severed the eventing chain before.
 */
function inTenant<T>(tenantId: string, fn: () => T): T {
  return RequestContext.run(
    { tenantId, correlationId: 'c-1', sourceService: undefined as never, startedAt: Date.now() },
    fn,
  );
}

describe('event payload contract', () => {
  it('stamps tenant + correlation on the envelope, not the payload', () => {
    const env = inTenant('tenant-X', () =>
      makeEnvelope(EventTopic.ExpenseApproved, {
        reportId: 'r1',
        status: 'approved',
        approvedBy: 'u1',
        amountMinor: 4200,
        recipientUserId: 'submitter-1',
      }),
    );
    expect(env.tenantId).toBe('tenant-X');
    expect(env.correlationId).toBe('c-1');
    // Tenant is NOT duplicated onto the payload (the consumer reads it from the envelope).
    expect((env.payload as unknown as Record<string, unknown>)['tenantId']).toBeUndefined();
  });

  it('expense.approved carries the recipient hint + renamed money/actor fields the consumer reads', () => {
    const env: EventEnvelope<ExpenseApprovedPayload> = inTenant('t', () =>
      makeEnvelope(EventTopic.ExpenseApproved, {
        reportId: 'r1',
        status: 'approved',
        approvedBy: 'mgr-1',
        amountMinor: 1000,
        recipientUserId: 'sub-1',
        recipientEmail: 'sub@example.com',
      }),
    );
    expect(env.payload.approvedBy).toBe('mgr-1');
    expect(env.payload.amountMinor).toBe(1000);
    expect(env.payload.recipientUserId).toBe('sub-1');
    expect(env.payload.recipientEmail).toBe('sub@example.com');
  });

  it('invoice.approved + payroll.run.approved carry a recipient hint', () => {
    const inv: EventEnvelope<InvoiceApprovedPayload> = inTenant('t', () =>
      makeEnvelope(EventTopic.InvoiceApproved, {
        invoiceId: 'i1',
        status: 'approved',
        vendorName: 'Acme',
        amountMinor: 999,
        recipientUserId: 'r',
      }),
    );
    const pay: EventEnvelope<PayRunApprovedPayload> = inTenant('t', () =>
      makeEnvelope(EventTopic.PayRunApproved, { payRunId: 'p1', approvedBy: 'a', recipientUserId: 'm' }),
    );
    expect(inv.payload.vendorName).toBe('Acme');
    expect(inv.payload.recipientUserId).toBe('r');
    expect(pay.payload.recipientUserId).toBe('m');
  });

  it('user-facing ApprovalRequested and workflow→service ApprovalCommand are distinct topics', () => {
    const requested: EventEnvelope<ApprovalRequestedPayload> = inTenant('t', () =>
      makeEnvelope(EventTopic.ApprovalRequested, {
        approvalId: 'a1',
        subjectType: 'expense_report',
        subjectId: 's1',
        requestedBy: 'u1',
        recipientUserId: 'approver-1',
      }),
    );
    const command: EventEnvelope<ApprovalCommandPayload> = inTenant('t', () =>
      makeEnvelope(EventTopic.ApprovalCommand, {
        recordType: 'expense_report',
        recordId: 's1',
        ruleId: 'rule-1',
        autoApprove: true,
      }),
    );
    expect(requested.topic).toBe(EventTopic.ApprovalRequested);
    expect(command.topic).toBe(EventTopic.ApprovalCommand);
    expect(requested.topic).not.toBe(command.topic);
    // The user-facing payload names a recipient; the command does not.
    expect(requested.payload.recipientUserId).toBe('approver-1');
    expect('recipientUserId' in command.payload).toBe(false);
  });
});
