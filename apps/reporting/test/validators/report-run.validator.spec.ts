import { ReportRunStatus } from '@aegis/shared-enums';
import {
  createRunSchema,
  createScheduleSchema,
  listRunsQuerySchema,
  listSchedulesQuerySchema,
  updateScheduleSchema,
} from '../../src/validators/report-run.validator';

describe('report-run validators', () => {
  describe('createRunSchema', () => {
    it('accepts a valid run request and defaults params to {}', () => {
      const { error, value } = createRunSchema.validate({
        definitionId: '11111111-1111-1111-1111-111111111111',
      });
      expect(error).toBeUndefined();
      expect(value.params).toEqual({});
    });

    it('keeps arbitrary params untouched', () => {
      const { error, value } = createRunSchema.validate({
        definitionId: '11111111-1111-1111-1111-111111111111',
        params: { from: '2026-01-01', to: '2026-02-01' },
      });
      expect(error).toBeUndefined();
      expect(value.params).toEqual({ from: '2026-01-01', to: '2026-02-01' });
    });

    it('rejects a non-uuid definitionId', () => {
      const { error } = createRunSchema.validate({ definitionId: 'not-a-uuid' });
      expect(error).toBeDefined();
    });

    it('requires a definitionId', () => {
      const { error } = createRunSchema.validate({});
      expect(error).toBeDefined();
    });
  });

  describe('listRunsQuerySchema', () => {
    it('coerces pagination and accepts status filters', () => {
      const { error, value } = listRunsQuerySchema.validate({
        page: '2',
        pageSize: '25',
        status: ReportRunStatus.Succeeded,
      });
      expect(error).toBeUndefined();
      expect(value.page).toBe(2);
      expect(value.pageSize).toBe(25);
    });

    it('rejects unknown statuses', () => {
      const { error } = listRunsQuerySchema.validate({ status: 'done' });
      expect(error).toBeDefined();
    });
  });

  describe('report schedule schemas', () => {
    it('accepts a schedule create request with defaults', () => {
      const { error, value } = createScheduleSchema.validate({
        definitionId: '11111111-1111-4111-8111-111111111111',
        cron: '0 9 * * 1',
      });
      expect(error).toBeUndefined();
      expect(value.timezone).toBe('UTC');
      expect(value.enabled).toBe(true);
    });

    it('accepts list filters for schedules', () => {
      const { error, value } = listSchedulesQuerySchema.validate({ enabled: 'false' });
      expect(error).toBeUndefined();
      expect(value.enabled).toBe(false);
    });

    it('requires at least one schedule patch field', () => {
      const { error } = updateScheduleSchema.validate({});
      expect(error).toBeDefined();
    });
  });
});
