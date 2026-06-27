/**
 * BUG-0003 — expense `applyRecordUpdate` (the service half the RecordUpdated consumer drives). SETs the
 * owning team, UNIONs the classification tags (distinct), records a `record_updated` shared-timeline
 * entry, and is idempotent: re-applying the same team/tags is a no-op (no write, no duplicate entry).
 */
import 'reflect-metadata';
import { ApprovalRecordType } from '@aegis/shared-enums';

const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
const attachRecordTags = jest.fn(
  async (opts: { tags: string[]; existingTags?: string[] | null }) => ({
    tags: [...(opts.existingTags ?? []), ...opts.tags].filter(
      (tag, idx, all) => all.indexOf(tag) === idx,
    ),
    added: opts.tags,
  }),
);
const detachRecordTags = jest.fn(async (_opts: unknown) => ({ tags: [], removed: [] }));
jest.mock('@aegis/db', () => ({
  RecordAnnotationFeatureFlag: 'record.annotations',
  withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])),
  attachRecordTags: (...a: unknown[]) => attachRecordTags(...(a as [never])),
  detachRecordTags: (...a: unknown[]) => detachRecordTags(...(a as [never])),
}));
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn() } }));
jest.mock('@aegis/connectors', () => ({
  ConnectorRegistry: {
    get: () => ({ pushTransaction: jest.fn().mockResolvedValue({ accepted: true }) }),
  },
}));

const activityRecord = jest.fn();
jest.mock('@aegis/activity', () => ({
  ActivityLogger: { record: (...a: unknown[]) => activityRecord(...a) },
}));

import { FeatureFlags, RequestContext } from '@aegis/service-core';
import { ExpenseService } from '../../src/services/expense.service';

const REPORT_ID = 'rep-1';

function makeReports(initial: Record<string, unknown>) {
  let current: Record<string, unknown> = { id: REPORT_ID, tenant_id: 't1', ...initial };
  return {
    findReportById: jest.fn(async () => current),
    applyLabels: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
      current = { ...current, ...patch };
    }),
  };
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: 'sys', correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

beforeEach(() => {
  FeatureFlags.setReader(async () => true);
  withTenantTransaction.mockClear();
  attachRecordTags.mockClear();
  detachRecordTags.mockClear();
  activityRecord.mockClear();
});

afterEach(() => {
  FeatureFlags.setReader(undefined);
});

it('sets team + tags on a bare report and logs a record_updated timeline entry', async () => {
  const reports = makeReports({ team_id: null, tags: null });
  const service = new ExpenseService(reports as never, {} as never, {} as never);
  await run(() =>
    service.applyRecordUpdate(REPORT_ID, {
      teamId: 'team-9',
      tags: ['urgent', 'q3'],
      ruleId: 'r1',
    }),
  );
  expect(reports.applyLabels).toHaveBeenCalledWith(
    REPORT_ID,
    { team_id: 'team-9', tags: ['urgent', 'q3'] },
    expect.anything(),
  );
  expect(activityRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      recordType: ApprovalRecordType.ExpenseReport,
      recordId: REPORT_ID,
      action: 'record_updated',
      details: expect.objectContaining({
        teamId: 'team-9',
        tagsAdded: ['urgent', 'q3'],
        ruleId: 'r1',
      }),
    }),
    expect.anything(),
  );
});

it('UNIONs new tags onto the existing set (distinct, only the added tag persisted/logged)', async () => {
  const reports = makeReports({ team_id: null, tags: ['urgent'] });
  const service = new ExpenseService(reports as never, {} as never, {} as never);
  await run(() => service.applyRecordUpdate(REPORT_ID, { tags: ['urgent', 'new'], ruleId: 'r2' }));
  expect(reports.applyLabels).toHaveBeenCalledWith(
    REPORT_ID,
    { tags: ['urgent', 'new'] },
    expect.anything(),
  );
  expect(activityRecord).toHaveBeenCalledWith(
    expect.objectContaining({
      details: expect.objectContaining({ teamId: undefined, tagsAdded: ['new'], ruleId: 'r2' }),
    }),
    expect.anything(),
  );
});

it('is an idempotent no-op when team + tags are already present (again-safe redelivery)', async () => {
  const reports = makeReports({ team_id: 'team-9', tags: ['urgent', 'q3'] });
  const service = new ExpenseService(reports as never, {} as never, {} as never);
  await run(() =>
    service.applyRecordUpdate(REPORT_ID, { teamId: 'team-9', tags: ['urgent'], ruleId: 'r3' }),
  );
  expect(reports.applyLabels).not.toHaveBeenCalled();
  expect(activityRecord).not.toHaveBeenCalled();
});

it('applies a team-only annotation without touching tags', async () => {
  const reports = makeReports({ team_id: null, tags: ['keep'] });
  const service = new ExpenseService(reports as never, {} as never, {} as never);
  await run(() => service.applyRecordUpdate(REPORT_ID, { teamId: 'team-2', ruleId: 'r4' }));
  expect(reports.applyLabels).toHaveBeenCalledWith(
    REPORT_ID,
    { team_id: 'team-2' },
    expect.anything(),
  );
});

it('does not mutate when record annotations are feature-flagged off', async () => {
  FeatureFlags.setReader(async () => false);
  const reports = makeReports({ team_id: null, tags: [] });
  const service = new ExpenseService(reports as never, {} as never, {} as never);
  await run(() => service.applyRecordUpdate(REPORT_ID, { teamId: 'team-9', tags: ['urgent'] }));
  expect(withTenantTransaction).not.toHaveBeenCalled();
  expect(reports.applyLabels).not.toHaveBeenCalled();
  expect(activityRecord).not.toHaveBeenCalled();
});

it('throws notFound when the report is RLS-invisible / missing (so the bus retries -> DLQ)', async () => {
  const reports = { findReportById: jest.fn(async () => null), applyLabels: jest.fn() };
  const service = new ExpenseService(reports as never, {} as never, {} as never);
  await expect(
    run(() => service.applyRecordUpdate(REPORT_ID, { teamId: 'team-9' })),
  ).rejects.toThrow(/not found/i);
  expect(reports.applyLabels).not.toHaveBeenCalled();
});
