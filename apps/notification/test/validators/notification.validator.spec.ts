import { EmailNotificationStatus } from '@aegis/shared-enums';
import {
  emailLogQuerySchema,
  idParamSchema,
  listQuerySchema,
} from '../../src/validators/notification.validator';

describe('notification validators', () => {
  describe('listQuerySchema', () => {
    it('accepts an empty query (all pagination fields optional)', () => {
      const { error } = listQuerySchema.validate({});
      expect(error).toBeUndefined();
    });

    it('coerces numeric strings to integers', () => {
      const { error, value } = listQuerySchema.validate({ page: '2', pageSize: '50' });
      expect(error).toBeUndefined();
      expect(value.page).toBe(2);
      expect(value.pageSize).toBe(50);
    });

    it('rejects a page below 1', () => {
      const { error } = listQuerySchema.validate({ page: 0 });
      expect(error).toBeDefined();
    });

    it('rejects a pageSize above the cap', () => {
      const { error } = listQuerySchema.validate({ pageSize: 500 });
      expect(error).toBeDefined();
    });
  });

  describe('idParamSchema', () => {
    it('accepts a valid uuid', () => {
      const { error } = idParamSchema.validate({ id: '11111111-1111-4111-8111-111111111111' });
      expect(error).toBeUndefined();
    });

    it('rejects a non-uuid id', () => {
      const { error } = idParamSchema.validate({ id: 'not-a-uuid' });
      expect(error).toBeDefined();
    });

    it('requires the id', () => {
      const { error } = idParamSchema.validate({});
      expect(error).toBeDefined();
    });
  });

  describe('emailLogQuerySchema', () => {
    it('accepts pagination plus status and user filters', () => {
      const { error, value } = emailLogQuerySchema.validate({
        page: '1',
        pageSize: '20',
        status: EmailNotificationStatus.Sent,
        userId: '11111111-1111-4111-8111-111111111111',
      });
      expect(error).toBeUndefined();
      expect(value.pageSize).toBe(20);
    });

    it('rejects an unknown email status', () => {
      const { error } = emailLogQuerySchema.validate({ status: 'unknown' });
      expect(error).toBeDefined();
    });
  });
});
