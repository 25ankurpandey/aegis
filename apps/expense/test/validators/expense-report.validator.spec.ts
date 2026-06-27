import {
  createReportSchema,
  attachExpenseSchema,
  approveSchema,
  rejectSchema,
  reimburseSchema,
  addCommentSchema,
  recallSchema,
} from '../../src/validators/expense-report.validator';

describe('expense-report validators', () => {
  describe('createReportSchema', () => {
    it('accepts a valid report', () => {
      const { error, value } = createReportSchema.validate({ name: 'Q2 travel', currency: 'USD' });
      expect(error).toBeUndefined();
      expect(value.name).toBe('Q2 travel');
    });

    it('requires a name', () => {
      const { error } = createReportSchema.validate({ currency: 'USD' });
      expect(error).toBeDefined();
    });

    it('rejects an empty name', () => {
      const { error } = createReportSchema.validate({ name: '' });
      expect(error).toBeDefined();
    });
  });

  describe('attachExpenseSchema', () => {
    it('accepts attaching an existing item by id', () => {
      const { error } = attachExpenseSchema.validate({
        expenseId: '33333333-3333-3333-3333-333333333333',
      });
      expect(error).toBeUndefined();
    });

    it('accepts creating a new item inline by amount', () => {
      const { error } = attachExpenseSchema.validate({ amount: 750 });
      expect(error).toBeUndefined();
    });

    it('requires either expenseId or amount', () => {
      const { error } = attachExpenseSchema.validate({ currency: 'USD' });
      expect(error).toBeDefined();
    });
  });

  describe('approveSchema', () => {
    it('accepts an empty body', () => {
      const { error } = approveSchema.validate({});
      expect(error).toBeUndefined();
    });

    it('accepts an optional comment', () => {
      const { error } = approveSchema.validate({ comment: 'looks good' });
      expect(error).toBeUndefined();
    });
  });

  describe('rejectSchema', () => {
    it('accepts an empty body', () => {
      const { error } = rejectSchema.validate({});
      expect(error).toBeUndefined();
    });

    it('accepts an optional reason', () => {
      const { error } = rejectSchema.validate({ reason: 'missing receipts' });
      expect(error).toBeUndefined();
    });

    it('rejects a non-string reason', () => {
      const { error } = rejectSchema.validate({ reason: 42 });
      expect(error).toBeDefined();
    });
  });

  describe('reimburseSchema', () => {
    it('accepts an empty body', () => {
      const { error } = reimburseSchema.validate({});
      expect(error).toBeUndefined();
    });

    it('accepts an optional comment', () => {
      const { error } = reimburseSchema.validate({ comment: 'paid via ACH' });
      expect(error).toBeUndefined();
    });
  });

  describe('addCommentSchema (W3-13b)', () => {
    it('accepts a non-empty body', () => {
      const { error, value } = addCommentSchema.validate({ body: 'please attach the receipt' });
      expect(error).toBeUndefined();
      expect(value.body).toBe('please attach the receipt');
    });

    it('requires a body', () => {
      const { error } = addCommentSchema.validate({});
      expect(error).toBeDefined();
    });

    it('rejects an empty body', () => {
      const { error } = addCommentSchema.validate({ body: '' });
      expect(error).toBeDefined();
    });
  });

  describe('recallSchema (W3-13c)', () => {
    it('accepts an empty body', () => {
      const { error } = recallSchema.validate({});
      expect(error).toBeUndefined();
    });

    it('accepts an optional reason', () => {
      const { error } = recallSchema.validate({ reason: 'need to add a line item' });
      expect(error).toBeUndefined();
    });

    it('rejects a non-string reason', () => {
      const { error } = recallSchema.validate({ reason: 42 });
      expect(error).toBeDefined();
    });
  });
});
