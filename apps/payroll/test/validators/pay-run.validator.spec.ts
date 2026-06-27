import { PayslipStatus } from '@aegis/shared-enums';
import {
  createPayRunSchema,
  decideSchema,
  payslipListQuerySchema,
} from '../../src/validators/pay-run.validator';

describe('pay-run validators', () => {
  describe('createPayRunSchema', () => {
    const valid = {
      periodStart: '2026-06-01',
      periodEnd: '2026-06-30',
      payDate: '2026-07-05',
    };

    it('accepts a minimal valid pay-run', () => {
      const { error } = createPayRunSchema.validate(valid);
      expect(error).toBeUndefined();
    });

    it('accepts an optional employeeIds array of uuids', () => {
      const { error } = createPayRunSchema.validate({
        ...valid,
        employeeIds: ['11111111-1111-4111-8111-111111111111'],
      });
      expect(error).toBeUndefined();
    });

    it('requires periodStart, periodEnd, and payDate', () => {
      const { error } = createPayRunSchema.validate({});
      expect(error).toBeDefined();
    });

    it('rejects a non-ISO date', () => {
      const { error } = createPayRunSchema.validate({ ...valid, payDate: 'not-a-date' });
      expect(error).toBeDefined();
    });

    it('rejects an unknown pay-run type', () => {
      const { error } = createPayRunSchema.validate({ ...valid, type: 'not-a-type' });
      expect(error).toBeDefined();
    });

    it('rejects a non-uuid in employeeIds', () => {
      const { error } = createPayRunSchema.validate({ ...valid, employeeIds: ['nope'] });
      expect(error).toBeDefined();
    });
  });

  describe('decideSchema', () => {
    it('accepts approved with an optional comment', () => {
      const { error } = decideSchema.validate({ decision: 'approved', comment: 'ok' });
      expect(error).toBeUndefined();
    });

    it('accepts rejected without a comment', () => {
      const { error } = decideSchema.validate({ decision: 'rejected' });
      expect(error).toBeUndefined();
    });

    it('requires a decision', () => {
      const { error } = decideSchema.validate({ comment: 'no decision' });
      expect(error).toBeDefined();
    });

    it('rejects a decision outside the approved/rejected vocabulary', () => {
      const { error } = decideSchema.validate({ decision: 'maybe' });
      expect(error).toBeDefined();
    });
  });

  describe('payslipListQuerySchema', () => {
    it('accepts pagination, pay-run, employee, and status filters', () => {
      const { error, value } = payslipListQuerySchema.validate({
        page: '2',
        pageSize: '25',
        payRunId: '11111111-1111-4111-8111-111111111111',
        employeeId: '22222222-2222-4222-8222-222222222222',
        status: PayslipStatus.Calculated,
      });
      expect(error).toBeUndefined();
      expect(value.page).toBe(2);
      expect(value.status).toBe(PayslipStatus.Calculated);
    });

    it('rejects an unknown payslip status', () => {
      const { error } = payslipListQuerySchema.validate({ status: 'funding' });
      expect(error).toBeDefined();
    });
  });
});
