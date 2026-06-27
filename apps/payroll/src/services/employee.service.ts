import type { Transaction } from 'sequelize';
import { inject } from 'inversify';
import { RequestContext } from '@aegis/service-core';
import { withTenantTransaction } from '@aegis/db';
import { AuditLogger } from '@aegis/audit';
import { AuditAction, AuditOutcome, EmploymentStatus } from '@aegis/shared-enums';
import { PayrollShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { EmployeeRepository } from '../repositories/employee.repository';
import { encryptField, decryptField, maskLast4 } from '../utils/field-crypto';

/**
 * Employee master data. Bank account and national id are AES-256-GCM field-encrypted on write.
 * On read they are decrypted then MASKED by default — clear values are only emitted to a principal
 * holding payroll.sensitive.read (a distinct permission from payroll.employee.view).
 */
@provideSingleton(EmployeeService)
export class EmployeeService {
  constructor(@inject(EmployeeRepository) private readonly repo: EmployeeRepository) {}

  async create(input: PayrollShape.CreateEmployeeInput): Promise<PayrollShape.EmployeeDto> {
    const tenantId = RequestContext.tenantId();
    return withTenantTransaction(async (t) => {
      const row = await this.repo.createEmployee(
        {
          tenant_id: tenantId,
          user_id: input.userId ?? null,
          person_ref: input.personRef ?? null,
          work_jurisdiction: input.workJurisdiction,
          residence_jurisdiction: input.residenceJurisdiction ?? null,
          employment_status: input.employmentStatus ?? EmploymentStatus.Active,
          bank_account_enc: encryptField(input.bankAccount),
          national_id_enc: encryptField(input.nationalId),
        },
        t,
      );
      // Even the creator gets a masked echo back; clear PII requires payroll.sensitive.read.
      return this.toDto(row, false);
    });
  }

  /**
   * List employees. `canReadSensitive` is the PDP obligation resolved at the PEP: it is true only
   * when the caller's token carries payroll.sensitive.read, in which case `_enc` fields are
   * decrypted in clear; otherwise they are masked. Default-deny: unknown ⇒ masked.
   */
  async list(canReadSensitive: boolean): Promise<PayrollShape.EmployeeDto[]> {
    return withTenantTransaction(async (t) => {
      const rows = await this.repo.listEmployees(t);
      const dtos = rows.map((r) => this.toDto(r, canReadSensitive));
      // SPEC §2.5 — audit EVERY sensitive-field read. When the caller holds the obligation and we
      // therefore return clear salary/bank/national-id, emit an audit row per employee naming the
      // fields revealed (actor + tenant come from the request context). Masked reads are not audited.
      if (canReadSensitive) {
        await this.auditSensitiveReads(rows, t);
      }
      return dtos;
    });
  }

  /**
   * Emit one hash-chained audit entry per employee whose clear PII was just revealed, recording the
   * actor (request context), tenant, employee id, and the exact sensitive fields disclosed. A
   * SOC2/GDPR access trail for decrypted PII (W5-08). The fields list reflects only columns that
   * actually held a value (an employee with no encrypted national id discloses only `bank_account`).
   */
  private async auditSensitiveReads(rows: PayrollShape.EmployeeRow[], t: Transaction): Promise<void> {
    const actorId = RequestContext.userId() ?? null;
    for (const row of rows) {
      const fields = this.revealedFields(row);
      if (fields.length === 0) continue; // nothing decrypted to clear ⇒ nothing to disclose
      await AuditLogger.record(
        {
          action: AuditAction.SensitiveFieldRead,
          outcome: AuditOutcome.Success,
          actorId,
          resourceType: 'employee',
          resourceId: row.id,
          details: { fields },
        },
        t,
      );
    }
  }

  /** The sensitive PII columns that carry a value (and are thus disclosed in clear) for a row. */
  private revealedFields(row: PayrollShape.EmployeeRow): string[] {
    const fields: string[] = [];
    if (row.bank_account_enc) fields.push('bank_account');
    if (row.national_id_enc) fields.push('national_id');
    if (row.tax_identifier_enc) fields.push('tax_identifier');
    return fields;
  }

  /** Decrypt-then-mask: never emit ciphertext; emit clear only when the sensitive obligation is granted. */
  private toDto(row: PayrollShape.EmployeeRow, canReadSensitive: boolean): PayrollShape.EmployeeDto {
    const bank = decryptField(row.bank_account_enc);
    const national = decryptField(row.national_id_enc);
    return {
      id: row.id,
      userId: row.user_id,
      employmentStatus: row.employment_status,
      workJurisdiction: row.work_jurisdiction,
      residenceJurisdiction: row.residence_jurisdiction,
      bankAccount: canReadSensitive ? bank : maskLast4(bank),
      nationalId: canReadSensitive ? national : (national ? '••••••••' : null),
    };
  }
}
