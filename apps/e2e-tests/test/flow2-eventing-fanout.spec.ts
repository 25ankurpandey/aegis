/**
 * FLOW 2 — EVENTING FAN-OUT (one domain event, two real consumers, over the REAL InProcessBus).
 *
 * A single approval/domain event is published on the REAL `@aegis/events` InProcessBus and reaches
 * BOTH consumers exactly as it does in the running system:
 *
 *   1. the WORKFLOW rules consumer — subscribed to `ApprovalCompleted`, it rebuilds the producer's
 *      RequestContext from the envelope (tenant + correlation id), normalises the payload to engine
 *      Facts, and runs the REAL `RuleService.evaluateRules` against a seeded active rule whose step
 *      matches, firing its real action handler (the action emits a follow-on `NotificationRequested`
 *      on the bus — the observable "the rule triggered" signal);
 *
 *   2. the NOTIFICATION consumer — subscribed to `ApprovalRequested`, it asserts the envelope tenant
 *      matches the propagated context, resolves the recipient HINT to a concrete recipient (REAL
 *      `RecipientResolverService`, with the user-management contact lookup mocked), renders the REAL
 *      template (content-map / TemplateEngine), and runs the REAL `NotificationService` →
 *      `EmailSenderService` idempotent send, with only the leaf `EmailProvider.send` + the DB mocked.
 *
 * Asserted: the event reaches both consumers carrying the TENANT FROM THE ENVELOPE (not the payload),
 * a notification ledger row is written, and an email send happens — i.e. the real fan-out chain.
 *
 * Uses the REAL bus (no setBus override) so the publish→rebuild-context→dispatch path is exercised
 * for real; the bus's own retry/DLQ semantics are covered separately in FLOW 3.
 */
import type { Transaction } from 'sequelize';
import { RequestContext, type RequestContextData } from '@aegis/service-core';
import {
  getBus,
  setBus,
  InProcessBus,
  makeEnvelope,
  EventTopic,
  type EventEnvelope,
  type ApprovalRequestedPayload,
} from '@aegis/events';
import {
  NotificationCode,
  RuleEvent,
  RuleActionType,
  RuleOperator,
  RuleConjunction,
  EmailNotificationStatus,
  ServiceName,
} from '@aegis/shared-enums';
import type { NotificationShape, WorkflowShape } from '@aegis/shared-types';

const TENANT = '33333333-3333-4333-8333-333333333333';
const CORRELATION = 'corr-flow2-0001';
const APPROVER = 'user-approver';
const TX = 'TX' as unknown as Transaction;

// withTenantTransaction → passthrough (the consumers' downstream services run inside one).
jest.mock('@aegis/db', () => ({
  withTenantTransaction: jest.fn(async (fn: (t: Transaction) => Promise<unknown>) => fn(TX)),
}));

// The HttpClient the recipient-resolver uses to look up a userId → contact. Mock it to return a real
// email so the email channel fans out (the resolver itself runs for real).
jest.mock('@aegis/service-core', () => {
  const actual = jest.requireActual('@aegis/service-core');
  return {
    ...actual,
    HttpClient: {
      call: jest.fn(async (_svc: unknown, _req: unknown) => ({
        userId: APPROVER,
        email: 'approver@example.test',
        phone: undefined,
      })),
    },
  };
});

// Workflow's rule.service appends to the shared activity timeline; stub it (DB write, not under test).
jest.mock('@aegis/activity', () => ({
  ActivityLogger: { record: jest.fn(async () => undefined) },
}));

// Imported AFTER the mocks so the real services bind to the mocked seams.
import { HttpClient } from '@aegis/service-core';
import { RecipientResolverService } from '../../../apps/notification/src/services/recipient-resolver.service';
import { NotificationService } from '../../../apps/notification/src/services/notification.service';
import { EmailSenderService } from '../../../apps/notification/src/services/email-sender.service';
import { SenderIdentityService } from '../../../apps/notification/src/services/sender-identity.service';
import { render } from '../../../apps/notification/src/services/content-map';
import { RuleService } from '../../../apps/workflow/src/services/rule.service';
import { registerBuiltinEngine } from '../../../apps/workflow/src/engine';
import type { Facts } from '../../../apps/workflow/src/engine/types';

// ---- observable sinks the real chain writes into -----------------------------------------------

/** The notification ledger (the in-app notifications table) — a row per resolved recipient. */
const notificationLedger: Array<Record<string, unknown>> = [];
/** Every email the real EmailSenderService actually handed to the (mocked) provider. */
const emailSends: Array<{ to: string; subject: string; body: string }> = [];
/** The email-log table the idempotent sender writes (sent/failed/policy rows). */
const emailLog: Array<Record<string, unknown>> = [];

// ---- hand-mocked leaf collaborators (DB repos + the email provider) ----------------------------
// Each preserves the real method contract; the real services orchestrate them.

function notificationRepoDouble(): unknown {
  return {
    createIfAbsent: jest.fn(async (row: Record<string, unknown>) => {
      const key = `${row['tenant_id']}:${row['user_id']}:${row['code']}:${row['correlation_id'] ?? ''}`;
      if (!notificationLedger.some((r) => r['_key'] === key)) {
        notificationLedger.push({ ...row, _key: key, id: `notif-${notificationLedger.length + 1}` });
      }
      return notificationLedger[notificationLedger.length - 1];
    }),
  };
}

function prefRepoDouble(): unknown {
  // Default-on: every channel enabled (no opt-out rows).
  return { isChannelEnabled: jest.fn(async (_q: unknown, _t: Transaction) => true) };
}

function emailLogRepoDouble(): unknown {
  return {
    findOrCreateForUpdate: jest.fn(async (row: Record<string, unknown>) => {
      let existing = emailLog.find((r) => r['idempotency_key'] === row['idempotency_key']);
      if (!existing) {
        existing = { ...row, id: `email-${emailLog.length + 1}`, status: EmailNotificationStatus.Pending };
        emailLog.push(existing);
      }
      return existing;
    }),
    markSent: jest.fn(async (id: string) => {
      const r = emailLog.find((x) => x['id'] === id);
      if (r) r['status'] = EmailNotificationStatus.Sent;
    }),
    markFailed: jest.fn(async (id: string, msg: string) => {
      const r = emailLog.find((x) => x['id'] === id);
      if (r) {
        r['status'] = EmailNotificationStatus.Failed;
        r['error_message'] = msg;
      }
    }),
    markPolicy: jest.fn(async (id: string, status: string) => {
      const r = emailLog.find((x) => x['id'] === id);
      if (r) r['status'] = status;
    }),
  };
}

function suppressionRepoDouble(): unknown {
  return { isSuppressed: jest.fn(async () => false) };
}

function senderIdentityRepoDouble(): unknown {
  // No configured identity ⇒ SenderIdentityService.resolve returns default-send (emailEnabled:true).
  return { findForTenant: jest.fn(async () => null) };
}

/** The leaf EmailProvider — THE mocked send (everything above it is the real send pipeline). */
function emailProviderDouble(): NotificationShape.EmailProvider {
  return {
    send: jest.fn(async (msg: NotificationShape.EmailMessage) => {
      emailSends.push({ to: msg.to, subject: msg.subject, body: msg.body });
      return `provider-ref-${emailSends.length}`;
    }),
  } as unknown as NotificationShape.EmailProvider;
}

/** Assemble the REAL notification service stack with leaf doubles (real orchestration logic). */
function buildNotificationService(): NotificationService {
  const sender = new EmailSenderService(
    emailLogRepoDouble() as never,
    emailProviderDouble() as never,
    new SenderIdentityService(senderIdentityRepoDouble() as never),
    suppressionRepoDouble() as never,
  );
  return new NotificationService(
    notificationRepoDouble() as never,
    { listForTenant: jest.fn(async () => ({ rows: [], count: 0 })) } as never,
    sender,
    // SMS sender is unused for this code (no phone on the recipient); a no-op double.
    { sendIdempotent: jest.fn(async () => undefined) } as never,
    prefRepoDouble() as never,
    new RecipientResolverService(),
  );
}

// ---- the workflow rule consumer (real RuleService + real engine, mocked repo) ------------------

/** One seeded ACTIVE rule that fires on ApprovalCompleted and notifies the record owner. */
const SEEDED_RULE: WorkflowShape.RuleRow = {
  id: 'rule-001',
  tenant_id: TENANT,
  name: 'notify-owner-on-approval',
  event: RuleEvent.ApprovalCompleted,
  active: true,
} as WorkflowShape.RuleRow;

const SEEDED_STEPS: WorkflowShape.RuleStepRow[] = [
  {
    id: 'step-1',
    tenant_id: TENANT,
    rule_id: 'rule-001',
    order: 1,
    // Fire for any completed expense-report approval. `record_type` is the canonical, always-present
    // key the `ApprovalCompleted` payload carries (the engine stamps it), so the rule matches the
    // real fan-out event. (`status` is not on the ApprovalCompleted contract — `outcome` is.)
    query: [
      { field: 'record_type', operator: RuleOperator.Equal, value: 'expense_report', conjunction: RuleConjunction.And },
    ],
  } as WorkflowShape.RuleStepRow,
];

const SEEDED_ACTIONS: WorkflowShape.RuleActionRow[] = [
  {
    id: 'action-1',
    tenant_id: TENANT,
    rule_id: 'rule-001',
    type: RuleActionType.Notify,
    config: { recipientUserId: 'owner-user', template: 'rule.notice' },
  } as WorkflowShape.RuleActionRow,
];

/** Audit rows the rule run appends (proves the rule actually executed end-to-end). */
const ruleAudit: Array<Record<string, unknown>> = [];

function ruleRepoDouble(): unknown {
  return {
    findActiveByEvent: jest.fn(async (event: string) =>
      event === SEEDED_RULE.event && SEEDED_RULE.active ? [SEEDED_RULE] : [],
    ),
    findSteps: jest.fn(async (ruleId: string) => (ruleId === SEEDED_RULE.id ? SEEDED_STEPS : [])),
    findActions: jest.fn(async (ruleId: string) => (ruleId === SEEDED_RULE.id ? SEEDED_ACTIONS : [])),
    appendAudit: jest.fn(async (row: Record<string, unknown>) => {
      const stored = { ...row, id: `audit-${ruleAudit.length + 1}` };
      ruleAudit.push(stored);
      return stored;
    }),
    touchLastRun: jest.fn(async () => undefined),
  };
}

function buildRuleService(): RuleService {
  registerBuiltinEngine();
  return new RuleService(ruleRepoDouble() as never);
}

// ---- wire the two REAL consumers onto the REAL bus (mirrors each service's registerConsumers) ----

/** What the workflow consumer normalises a domain envelope into (mirrors consumers/index.toFacts). */
function toFacts(env: EventEnvelope): Facts {
  const payload = (env.payload ?? {}) as Record<string, unknown>;
  const recordType = (payload['recordType'] as string | undefined) ?? (payload['record_type'] as string | undefined);
  const id = payload['recordId'] ?? payload['id'];
  return { ...payload, record_type: recordType, id };
}

/** The tenant each consumer SAW when it ran — proves the envelope tenant propagated into context. */
const seenTenant = { workflow: '', notification: '' };

function registerConsumers(notifications: NotificationService, rules: RuleService): void {
  const bus = getBus();

  // WORKFLOW: ApprovalCompleted → run the real rule engine. The bus has already rebuilt the context
  // from the envelope, so RLS/tenant attribution holds across the async hop.
  bus.subscribe(EventTopic.ApprovalCompleted, async (env: EventEnvelope) => {
    seenTenant.workflow = RequestContext.tenantId(); // from the rebuilt context (envelope-sourced)
    await rules.evaluateRules(RuleEvent.ApprovalCompleted, toFacts(env));
  });

  // NOTIFICATION: ApprovalRequested → resolve recipient + render + send (real chain).
  bus.subscribe(EventTopic.ApprovalRequested, async (env: EventEnvelope) => {
    const ctxTenant = RequestContext.tenantId(); // fail-closed; from the rebuilt context
    if (!env.tenantId || env.tenantId !== ctxTenant) {
      throw new Error('event tenant does not match propagated context tenant');
    }
    seenTenant.notification = ctxTenant;
    const payload = env.payload as ApprovalRequestedPayload;
    const message: NotificationShape.NotificationMessage = {
      code: NotificationCode.ApprovalRequested,
      approvalId: payload.approvalId,
      subjectType: payload.subjectType,
      subjectId: payload.subjectId,
      requestedBy: payload.requestedBy,
    };
    await notifications.resolveAndDispatch(message, {
      kind: 'user',
      userId: payload.recipientUserId,
    });
  });
}

beforeEach(() => {
  // The InProcessBus has no unsubscribe; swap in a FRESH real bus per test so subscriptions from a
  // prior test never linger (each test wires its own consumers onto a clean bus). It is still the
  // real transport — publish → context-rebuild → dispatch runs for real.
  setBus(new InProcessBus());
  notificationLedger.length = 0;
  emailSends.length = 0;
  emailLog.length = 0;
  ruleAudit.length = 0;
  seenTenant.workflow = '';
  seenTenant.notification = '';
  (HttpClient.call as jest.Mock).mockClear();
});

// ---- the flow ---------------------------------------------------------------------------------

/** Publish `topic` inside a producer RequestContext stamping the tenant + correlation id (as HTTP would). */
async function publishInContext<T>(topic: EventTopic, payload: T): Promise<void> {
  const seed: RequestContextData = {
    tenantId: TENANT,
    correlationId: CORRELATION,
    sourceService: ServiceName.Expense as never,
    startedAt: Date.now(),
  };
  await RequestContext.run(seed, async () => {
    await getBus().publish(makeEnvelope(topic, payload as never));
  });
}

describe('FLOW 2 — one domain event fans out to the workflow + notification consumers over the real bus', () => {
  it('NOTIFICATION consumer: ApprovalRequested → recipient resolved → template rendered → email sent + ledger row', async () => {
    registerConsumers(buildNotificationService(), buildRuleService());

    await publishInContext(EventTopic.ApprovalRequested, {
      approvalId: 'appr-1',
      subjectType: 'expense_report',
      subjectId: 'report-001',
      requestedBy: 'user-carol',
      recordType: 'expense_report',
      recordId: 'report-001',
      level: 1,
      recipientUserId: APPROVER,
    });

    // The consumer ran under the ENVELOPE's tenant (rebuilt into context), not the payload.
    expect(seenTenant.notification).toBe(TENANT);
    // Recipient HINT (userId only) was resolved to a concrete contact via the (mocked) lookup.
    expect(HttpClient.call).toHaveBeenCalledWith(ServiceName.UserManagement, expect.anything());
    // A notification ledger row was written for the resolved recipient, tenant from the envelope.
    expect(notificationLedger).toHaveLength(1);
    expect(notificationLedger[0]).toMatchObject({
      tenant_id: TENANT,
      user_id: APPROVER,
      code: NotificationCode.ApprovalRequested,
      correlation_id: CORRELATION,
    });
    // And the real send pipeline handed exactly one rendered email to the (mocked) provider.
    expect(emailSends).toHaveLength(1);
    expect(emailSends[0].to).toBe('approver@example.test');
    // The body is the REAL rendered template for this code (content-map / TemplateEngine).
    const expected = render({
      code: NotificationCode.ApprovalRequested,
      approvalId: 'appr-1',
      subjectType: 'expense_report',
      subjectId: 'report-001',
      requestedBy: 'user-carol',
    });
    // Body is the exact rendered template; the subject is the rendered subject possibly carrying the
    // real gating policy's non-prod prefix (EmailGatingPolicy ran for real), so assert containment.
    expect(emailSends[0].body).toBe(expected.body);
    expect(emailSends[0].subject).toContain(expected.subject);
    // The idempotent email-log row settled to `sent`.
    expect(emailLog).toHaveLength(1);
    expect(emailLog[0]['status']).toBe(EmailNotificationStatus.Sent);
  });

  it('WORKFLOW consumer: ApprovalCompleted → the matching rule fires (audit row + follow-on event)', async () => {
    registerConsumers(buildNotificationService(), buildRuleService());

    // A follow-on NotificationRequested is the action's observable side effect — capture it.
    const followOns: EventEnvelope[] = [];
    getBus().subscribe(EventTopic.NotificationRequested, (env: EventEnvelope) => {
      followOns.push(env);
    });

    await publishInContext(EventTopic.ApprovalCompleted, {
      approvalId: 'appr-2',
      subjectType: 'expense_report',
      subjectId: 'report-001',
      outcome: 'approved',
      recordType: 'expense_report',
      recordId: 'report-001',
      decidedBy: 'user-bob',
    });

    // The rule consumer ran under the envelope tenant.
    expect(seenTenant.workflow).toBe(TENANT);
    // The real rule engine evaluated the seeded rule, its step matched, and it appended a run audit.
    expect(ruleAudit).toHaveLength(1);
    expect(ruleAudit[0]).toMatchObject({ tenant_id: TENANT, rule_id: SEEDED_RULE.id });
    // The notify action fired a follow-on NotificationRequested carrying the same propagated tenant.
    expect(followOns).toHaveLength(1);
    expect(followOns[0].tenantId).toBe(TENANT);
    expect(followOns[0].correlationId).toBe(CORRELATION);
    expect(followOns[0].payload).toMatchObject({ recipientUserId: 'owner-user' });
  });

  it('FAN-OUT: a single envelope reaches BOTH a workflow AND a notification consumer on the same topic', async () => {
    // Subscribe BOTH consumers to ApprovalCompleted to prove multi-subscriber fan-out on one publish.
    const rules = buildRuleService();
    const notifications = buildNotificationService();
    const bus = getBus();

    let workflowSawTenant = '';
    let notificationSawTenant = '';

    bus.subscribe(EventTopic.ApprovalCompleted, async (env: EventEnvelope) => {
      workflowSawTenant = RequestContext.tenantId();
      await rules.evaluateRules(RuleEvent.ApprovalCompleted, toFacts(env));
    });
    bus.subscribe(EventTopic.ApprovalCompleted, async (env: EventEnvelope) => {
      notificationSawTenant = RequestContext.tenantId();
      const payload = (env.payload ?? {}) as Record<string, unknown>;
      await notifications.resolveAndDispatch(
        {
          code: NotificationCode.ApprovalRequested,
          approvalId: 'appr-3',
          subjectType: payload['recordType'] as string,
          subjectId: payload['recordId'] as string,
          requestedBy: 'user-bob',
        },
        { kind: 'user', userId: APPROVER },
      );
    });

    await publishInContext(EventTopic.ApprovalCompleted, {
      approvalId: 'appr-3',
      subjectType: 'expense_report',
      subjectId: 'report-001',
      outcome: 'approved',
      recordType: 'expense_report',
      recordId: 'report-001',
      decidedBy: 'user-bob',
    });

    // BOTH consumers fired for the single publish, each carrying the envelope's tenant.
    expect(workflowSawTenant).toBe(TENANT);
    expect(notificationSawTenant).toBe(TENANT);
    expect(ruleAudit).toHaveLength(1); // workflow side ran the rule
    expect(emailSends).toHaveLength(1); // notification side sent the email
    expect(notificationLedger).toHaveLength(1);
  });
});
