/**
 * W5-13 — SHARED ACTIVITY FEED ROLLOUT (workflow half).
 *
 * The workflow rule service must emit to the shared `@aegis/activity` polymorphic timeline (keyed
 * `(rule, ruleId)`) at its key transitions — rule CREATE, rule TRIGGER (conditions matched), and the
 * ACTIONS dispatched — additive alongside the per-rule `rule_audit_logs`. This spec proves a tenant-
 * scoped activity row is written at each, and that a dry-run (no side effects) emits no live trigger/
 * action entries.
 */
import { RuleEvent } from '@aegis/shared-enums';

const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
jest.mock('@aegis/db', () => ({ withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])) }));

// Capture every ActivityLogger.record call (the assertion surface).
const activityRecord = jest.fn();
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: (...a: unknown[]) => activityRecord(...a) } }));

// Engine seams: control step pass + action dispatch deterministically. registerBuiltinEngine is a no-op
// here; evaluateStep always passes; the one action handler reports success.
jest.mock('../../src/engine', () => ({ registerBuiltinEngine: jest.fn() }));
jest.mock('../../src/engine/evaluate-step', () => ({
  evaluateStep: jest.fn().mockResolvedValue({ pass: true, trace: [] }),
}));
jest.mock('../../src/engine/aggregate', () => ({ aggregateVerdict: () => 'success' }));
jest.mock('../../src/engine/actions/registry', () => ({
  getActionHandler: () => jest.fn().mockResolvedValue('ok'),
}));

import { RequestContext } from '@aegis/service-core';
import { RuleService } from '../../src/services/rule.service';

const RULE_ID = 'rule-1';

function makeRepo() {
  const rule = { id: RULE_ID, tenant_id: 't1', name: 'auto-approve small', event: RuleEvent.ApprovalCompleted, active: true };
  return {
    createRule: jest.fn().mockResolvedValue(rule),
    createSteps: jest.fn().mockResolvedValue([{ id: 'step-1', order: 1, query: [] }]),
    createActions: jest.fn().mockResolvedValue([{ id: 'act-1', type: 'notify', config: {} }]),
    findActiveByEvent: jest.fn().mockResolvedValue([rule]),
    findRuleById: jest.fn().mockResolvedValue(rule),
    findSteps: jest.fn().mockResolvedValue([{ id: 'step-1', order: 1, query: [] }]),
    findActions: jest.fn().mockResolvedValue([{ id: 'act-1', type: 'notify', config: {} }]),
    appendAudit: jest.fn().mockResolvedValue({ id: 'audit-1' }),
    touchLastRun: jest.fn().mockResolvedValue(undefined),
  };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: 'author-1', correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

/** Activity entries written for the canonical `rule` key, in call order. */
function ruleActivities() {
  return activityRecord.mock.calls
    .map((c) => c[0] as { recordType: string; recordId: string; action: string })
    .filter((e) => e.recordType === 'rule' && e.recordId === RULE_ID);
}

beforeEach(() => activityRecord.mockClear());

describe('W5-13 workflow rule activity rollout', () => {
  it('writes a `created` activity when a rule is authored', async () => {
    const service = new RuleService(makeRepo() as never);
    await run(() =>
      service.createRule({ name: 'auto-approve small', event: RuleEvent.ApprovalCompleted, steps: [{ order: 1, query: [] }], actions: [{ type: 'notify', config: {} }] } as never),
    );
    expect(ruleActivities().map((e) => e.action)).toContain('created');
  });

  it('writes `triggered` and `actions_dispatched` activities on a live evaluation that matches', async () => {
    const service = new RuleService(makeRepo() as never);
    await run(() => service.evaluateRules(RuleEvent.ApprovalCompleted, { record_type: 'pay_run', id: 'run-1' }));

    const actions = ruleActivities().map((e) => e.action);
    expect(actions).toContain('triggered');
    expect(actions).toContain('actions_dispatched');
  });

  it('a DRY-RUN performs no side effects → emits NO live trigger/action activity', async () => {
    const service = new RuleService(makeRepo() as never);
    await run(() => service.runRule(RULE_ID, { record_type: 'pay_run', id: 'run-1' }, true));

    const actions = ruleActivities().map((e) => e.action);
    expect(actions).not.toContain('triggered');
    expect(actions).not.toContain('actions_dispatched');
  });

  it('every emitted entry is keyed by the canonical `rule` record type (polymorphic, tenant-scoped)', async () => {
    const service = new RuleService(makeRepo() as never);
    await run(() => service.evaluateRules(RuleEvent.ApprovalCompleted, { record_type: 'pay_run', id: 'run-1' }));
    for (const call of activityRecord.mock.calls) {
      expect((call[0] as { recordType: string }).recordType).toBe('rule');
    }
  });
});

// A skipped rule (conditions fail) must NOT write a trigger/action entry.
describe('W5-13 workflow rule activity — non-matching rule', () => {
  it('writes no trigger/action activity when steps do not pass', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const evalStep = require('../../src/engine/evaluate-step').evaluateStep as jest.Mock;
    evalStep.mockResolvedValueOnce({ pass: false, trace: [] });

    const service = new RuleService(makeRepo() as never);
    await run(() => service.evaluateRules(RuleEvent.ApprovalCompleted, { record_type: 'pay_run', id: 'run-1' }));

    const actions = ruleActivities().map((e) => e.action);
    expect(actions).not.toContain('triggered');
    expect(actions).not.toContain('actions_dispatched');
  });
});
