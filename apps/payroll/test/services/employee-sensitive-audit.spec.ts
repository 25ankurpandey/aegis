/**
 * W5-08 — SPEC §2.5 mandates auditing EVERY sensitive-field read. When a principal holding the
 * sensitive obligation reads clear salary/bank/national-id, the service must write an audit row
 * (actor, tenant, employee id, fields revealed). A masked read writes nothing.
 */
import { AuditAction, AuditOutcome } from '@aegis/shared-enums';

const withTenantTransaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn({}));
jest.mock('@aegis/db', () => ({ withTenantTransaction: (...a: unknown[]) => withTenantTransaction(...(a as [never])) }));

const auditRecord = jest.fn();
jest.mock('@aegis/audit', () => ({ AuditLogger: { record: (...a: unknown[]) => auditRecord(...a) } }));

// The audit decision keys off whether the `_enc` columns hold a value, not the crypto itself —
// stub field-crypto so the test rows can use simple sentinel ciphertext.
jest.mock('../../src/utils/field-crypto', () => ({
  decryptField: (s: string | null) => (s ? `clear:${s}` : null),
  encryptField: (s: string | null) => s,
  maskLast4: (s: string | null) => (s ? `•••• ${s.slice(-4)}` : null),
}));

import { RequestContext } from '@aegis/service-core';
import { EmployeeService } from '../../src/services/employee.service';

// A row whose PII columns hold (dummy) ciphertext; decryptField is tolerant of non-decryptable input.
function empRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'emp-1',
    tenant_id: 't1',
    person_ref: null,
    legal_entity_id: null,
    employment_status: 'active',
    work_jurisdiction: 'US-CA',
    residence_jurisdiction: null,
    bank_account_enc: 'enc:bank',
    national_id_enc: 'enc:nid',
    tax_identifier_enc: null,
    ...overrides,
  };
}

function makeRepo(rows: Record<string, unknown>[]) {
  return { listEmployees: jest.fn().mockResolvedValue(rows) };
}

function asActor<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { tenantId: 't1', userId: 'reader-1', correlationId: 'c', startedAt: Date.now() } as never,
    fn,
  );
}

describe('EmployeeService.list — sensitive-field read audit (W5-08)', () => {
  beforeEach(() => auditRecord.mockClear());

  it('writes a SensitiveFieldRead audit row per employee when clear PII is revealed', async () => {
    const repo = makeRepo([empRow()]);
    const service = new EmployeeService(repo as never);

    await asActor(() => service.list(true));

    expect(auditRecord).toHaveBeenCalledTimes(1);
    const [input] = auditRecord.mock.calls[0];
    expect(input).toMatchObject({
      action: AuditAction.SensitiveFieldRead,
      outcome: AuditOutcome.Success,
      actorId: 'reader-1',
      resourceType: 'employee',
      resourceId: 'emp-1',
      details: { fields: ['bank_account', 'national_id'] },
    });
  });

  it('only names fields that actually hold a value', async () => {
    const repo = makeRepo([empRow({ national_id_enc: null, tax_identifier_enc: 'enc:tax' })]);
    const service = new EmployeeService(repo as never);

    await asActor(() => service.list(true));

    const [input] = auditRecord.mock.calls[0];
    expect(input.details).toEqual({ fields: ['bank_account', 'tax_identifier'] });
  });

  it('does NOT audit a masked (non-sensitive) read', async () => {
    const repo = makeRepo([empRow()]);
    const service = new EmployeeService(repo as never);

    await asActor(() => service.list(false));

    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('skips employees with no encrypted PII even on a sensitive read', async () => {
    const repo = makeRepo([empRow({ bank_account_enc: null, national_id_enc: null })]);
    const service = new EmployeeService(repo as never);

    await asActor(() => service.list(true));

    expect(auditRecord).not.toHaveBeenCalled();
  });
});
