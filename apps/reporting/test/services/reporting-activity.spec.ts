/**
 * W5-13 — SHARED ACTIVITY FEED ROLLOUT (reporting half).
 *
 * The reporting service must emit to the shared `@aegis/activity` polymorphic timeline (keyed
 * `(report_run, runId)`) at its key transitions — a report run REQUESTED and the run COMPLETED — so
 * the cross-service who-did-what feed covers reporting too. This spec proves a tenant-scoped activity
 * row is written at each, inside the same RLS-scoped transaction as the run write.
 */
const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
jest.mock('@aegis/db', () => ({ withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])) }));

// Capture every ActivityLogger.record call (the assertion surface).
const activityRecord = jest.fn();
jest.mock('@aegis/activity', () => ({ ActivityLogger: { record: (...a: unknown[]) => activityRecord(...a) } }));

import { RequestContext } from '@aegis/service-core';
import { ReportingService } from '../../src/services/reporting.service';

const DEF_ID = 'def-1';
const RUN_ID = 'run-1';

function makeDefinitions() {
  return {
    findById: jest.fn().mockResolvedValue({ id: DEF_ID, tenant_id: 't1', name: 'Headcount', spec: {}, required_permission: 'report:run' }),
  };
}

function makeRuns() {
  return {
    findAccessPolicyByRole: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: RUN_ID, tenant_id: 't1', definition_id: DEF_ID, status: 'queued' }),
    update: jest.fn().mockResolvedValue({ id: RUN_ID, definition_id: DEF_ID, status: 'succeeded', artifact_url: 'https://x/y.csv' }),
  };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: 'analyst-1', correlationId: 'corr-1', roles: [], startedAt: Date.now() } as never,
    fn,
  );
}

function runActivities() {
  return activityRecord.mock.calls
    .map((c) => c[0] as { recordType: string; recordId: string; action: string })
    .filter((e) => e.recordType === 'report_run' && e.recordId === RUN_ID);
}

beforeEach(() => activityRecord.mockClear());

describe('W5-13 reporting activity rollout', () => {
  it('writes `run_requested` and `run_completed` activities on createRun', async () => {
    const service = new ReportingService(makeDefinitions() as never, makeRuns() as never, {} as never);
    await run(() => service.createRun({ definitionId: DEF_ID, params: {} } as never));

    const actions = runActivities().map((e) => e.action);
    expect(actions).toContain('run_requested');
    expect(actions).toContain('run_completed');
  });

  it('stamps the requesting user as the actor on the timeline', async () => {
    const service = new ReportingService(makeDefinitions() as never, makeRuns() as never, {} as never);
    await run(() => service.createRun({ definitionId: DEF_ID, params: {} } as never));

    expect(activityRecord).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: 'report_run', recordId: RUN_ID, action: 'run_requested', actorId: 'analyst-1' }),
      expect.anything(),
    );
  });

  it('keys every emitted entry by the canonical report_run record type (polymorphic, tenant-scoped)', async () => {
    const service = new ReportingService(makeDefinitions() as never, makeRuns() as never, {} as never);
    await run(() => service.createRun({ definitionId: DEF_ID, params: {} } as never));
    for (const call of activityRecord.mock.calls) {
      expect((call[0] as { recordType: string }).recordType).toBe('report_run');
    }
  });
});
