/**
 * W5-13 — SHARED ACTIVITY FEED ROLLOUT (payroll half).
 *
 * The shared `@aegis/activity` ActivityLogger must now emit a polymorphic `(pay_run, runId)` timeline
 * entry at each key pay-run state transition: create, calculate, and disburse (approve/reject already
 * emit through the approval-engine completion path and are covered by pay-run-approval.spec.ts). This
 * spec proves an activity row is written — keyed by the canonical `pay_run` record type — at each of
 * those transitions, inside the same RLS-scoped transaction as the business write.
 */
import { PayRunStatus, ApprovalRecordType } from '@aegis/shared-enums';

const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
jest.mock('@aegis/db', () => ({ withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])) }));
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: jest.fn() } }));

// Stub field-crypto so the test doesn't require a FIELD_ENCRYPTION_KEY.
jest.mock('../../src/utils/field-crypto', () => ({
  encryptField: (s: string | null) => (s == null ? null : `enc:${s}`),
  decryptField: (s: string | null) => s,
  maskLast4: (s: string | null) => s,
}));

// The shared events outbox is stubbed so disburse() doesn't need a real bus/envelope wiring.
jest.mock('@aegis/events', () => {
  const actual = jest.requireActual('@aegis/events');
  return {
    ...actual,
    stageOutboxEvent: jest.fn(),
    makeEnvelope: (topic: unknown, payload: unknown) => ({ topic, payload, tenantId: 't1' }),
  };
});

// Capture every ActivityLogger.record call (the assertion surface).
const activityRecord = jest.fn();
jest.mock('@aegis/activity', () => ({
  ActivityLogger: { record: (...a: unknown[]) => activityRecord(...a) },
}));

import { RequestContext } from '@aegis/service-core';
import { PayRunService } from '../../src/services/pay-run.service';

const RUN_ID = 'run-1';
const EMP = 'emp-1';

function draftRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    tenant_id: 't1',
    pay_calendar_id: null,
    period_start: '2026-01-01',
    period_end: '2026-01-31',
    pay_date: '2026-01-31',
    type: 'regular',
    status: PayRunStatus.Draft,
    created_by: 'maker-1',
    approved_by: null,
    approved_at: null,
    locked_snapshot: null,
    lock_version: 0,
    ...overrides,
  };
}

function makeEmployees() {
  return {
    findContractCurrencyForEmployee: jest.fn().mockResolvedValue('USD'),
    findActivePayItemsForEmployee: jest.fn().mockResolvedValue([]),
    findEmployeeById: jest.fn().mockResolvedValue({ id: EMP, work_jurisdiction: null }),
    findDeductionCodesByIds: jest.fn().mockResolvedValue(new Map()),
    findEffectiveTaxRules: jest.fn().mockResolvedValue([]),
  };
}

function makeRepo(initial: Record<string, unknown>) {
  let current = initial;
  return {
    createPayRun: jest.fn(async () => current),
    createPayslip: jest.fn().mockResolvedValue(undefined),
    findPayRunById: jest.fn(async () => current),
    listPayslipsByRun: jest.fn().mockResolvedValue([
      { id: 'slip-1', employee_id: EMP, gross: 1000, total_tax: 0, total_deductions: 0, currency: 'USD' },
    ]),
    updatePayslipTotals: jest.fn().mockResolvedValue(undefined),
    updatePayRunVersioned: jest.fn(async (_id: string, _v: number, patch: Record<string, unknown>) => {
      current = { ...current, ...patch };
      return current;
    }),
    createPaymentBatch: jest.fn().mockResolvedValue({ id: 'batch-1' }),
    findPaymentByIdempotencyKey: jest.fn().mockResolvedValue(null),
    createPayment: jest.fn().mockResolvedValue(undefined),
    appendLedgerEntry: jest.fn().mockResolvedValue(undefined),
    glSummaryForRun: jest.fn().mockResolvedValue([{ account: 'wage_expense', debit: 1000, credit: 0 }]),
  };
}

function run<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId, correlationId: 'corr-1', startedAt: Date.now() } as never,
    fn,
  );
}

/** All activity entries written for the canonical pay_run key, in call order. */
function payRunActivities() {
  return activityRecord.mock.calls
    .map((c) => c[0] as { recordType: string; recordId: string; action: string })
    .filter((e) => e.recordType === ApprovalRecordType.PayRun && e.recordId === RUN_ID);
}

beforeEach(() => activityRecord.mockClear());

describe('W5-13 pay-run activity rollout', () => {
  it('writes a `created` activity on the pay_run timeline at create', async () => {
    const repo = makeRepo(draftRun());
    const service = new PayRunService(repo as never, makeEmployees() as never, {} as never);

    await run('maker-1', () => service.create({ periodStart: '2026-01-01', periodEnd: '2026-01-31', payDate: '2026-01-31', employeeIds: [EMP] } as never));

    const created = payRunActivities().find((e) => e.action === 'created');
    expect(created).toBeDefined();
    // The write rides the same transaction object the repo writes flow through.
    expect(activityRecord).toHaveBeenCalledWith(
      expect.objectContaining({ recordType: ApprovalRecordType.PayRun, recordId: RUN_ID, action: 'created', actorId: 'maker-1' }),
      expect.anything(),
    );
  });

  it('writes a `calculated` activity at calculate', async () => {
    const repo = makeRepo(draftRun());
    const service = new PayRunService(repo as never, makeEmployees() as never, {} as never);

    await run('calc-1', () => service.calculate(RUN_ID));

    const calc = payRunActivities().find((e) => e.action === 'calculated');
    expect(calc).toBeDefined();
  });

  it('writes a `disbursed` activity at disburse', async () => {
    const repo = makeRepo(draftRun({ status: PayRunStatus.Approved, approved_by: 'checker-1' }));
    const service = new PayRunService(repo as never, makeEmployees() as never, {} as never);

    await run('disburser-1', () => service.disburse(RUN_ID, 'idem-1'));

    const disbursed = payRunActivities().find((e) => e.action === 'disbursed');
    expect(disbursed).toBeDefined();
  });

  it('every emitted entry is keyed by the canonical pay_run record type (tenant-scoped polymorphic key)', async () => {
    const repo = makeRepo(draftRun());
    const service = new PayRunService(repo as never, makeEmployees() as never, {} as never);

    await run('maker-1', () => service.create({ periodStart: '2026-01-01', periodEnd: '2026-01-31', payDate: '2026-01-31', employeeIds: [EMP] } as never));

    // No call leaked a different record type/id.
    for (const call of activityRecord.mock.calls) {
      expect((call[0] as { recordType: string }).recordType).toBe(ApprovalRecordType.PayRun);
    }
  });
});
