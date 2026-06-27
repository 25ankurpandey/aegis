import { createExpenseSchema } from '../../src/validators/expense.validator';

describe('expense validators', () => {
  describe('createExpenseSchema', () => {
    it('accepts a minimal valid item (integer minor units)', () => {
      const { error, value } = createExpenseSchema.validate({ amount: 1299 });
      expect(error).toBeUndefined();
      expect(value.amount).toBe(1299);
    });

    it('accepts the full optional surface', () => {
      const { error } = createExpenseSchema.validate({
        amount: 5000,
        currency: 'USD',
        merchant: 'Cafe',
        incurredOn: '2026-06-26',
        description: 'Lunch',
        categoryId: '11111111-1111-1111-1111-111111111111',
        receiptRef: 'r-1',
        reportId: '22222222-2222-2222-2222-222222222222',
      });
      expect(error).toBeUndefined();
    });

    it('requires amount', () => {
      const { error } = createExpenseSchema.validate({ currency: 'USD' });
      expect(error).toBeDefined();
    });

    it('rejects a non-integer amount', () => {
      const { error } = createExpenseSchema.validate({ amount: 12.5 });
      expect(error).toBeDefined();
    });

    it('rejects a currency that is not 3 chars', () => {
      const { error } = createExpenseSchema.validate({ amount: 100, currency: 'US' });
      expect(error).toBeDefined();
    });

    it('rejects a non-uuid categoryId', () => {
      const { error } = createExpenseSchema.validate({ amount: 100, categoryId: 'not-a-uuid' });
      expect(error).toBeDefined();
    });
  });
});
