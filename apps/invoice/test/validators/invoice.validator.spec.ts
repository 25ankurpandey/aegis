import { createInvoiceSchema, approveInvoiceSchema } from '../../src/validators/invoice.validator';

describe('invoice validators', () => {
  describe('createInvoiceSchema', () => {
    const valid = {
      vendorName: 'Acme Corp',
      invoiceNumber: 'INV-001',
      invoiceDate: '2026-01-15',
      amountMinor: 12500,
      currency: 'USD',
    };

    it('accepts a valid invoice', () => {
      const { error, value } = createInvoiceSchema.validate(valid);
      expect(error).toBeUndefined();
      expect(value.currency).toBe('USD');
    });

    it('uppercases the currency code', () => {
      const { error, value } = createInvoiceSchema.validate({ ...valid, currency: 'usd' });
      expect(error).toBeUndefined();
      expect(value.currency).toBe('USD');
    });

    it('rejects a non-3-letter currency', () => {
      const { error } = createInvoiceSchema.validate({ ...valid, currency: 'US' });
      expect(error).toBeDefined();
    });

    it('rejects a negative amount', () => {
      const { error } = createInvoiceSchema.validate({ ...valid, amountMinor: -1 });
      expect(error).toBeDefined();
    });

    it('rejects a non-integer amount', () => {
      const { error } = createInvoiceSchema.validate({ ...valid, amountMinor: 12.5 });
      expect(error).toBeDefined();
    });

    it('rejects a non-ISO invoice date', () => {
      const { error } = createInvoiceSchema.validate({ ...valid, invoiceDate: 'not-a-date' });
      expect(error).toBeDefined();
    });

    it('rejects an unknown transaction type', () => {
      const { error } = createInvoiceSchema.validate({ ...valid, transactionType: 'sideways' });
      expect(error).toBeDefined();
    });

    it('requires vendorName, invoiceNumber, invoiceDate, amountMinor and currency', () => {
      const { error } = createInvoiceSchema.validate({});
      expect(error).toBeDefined();
    });
  });

  describe('approveInvoiceSchema', () => {
    it('accepts an empty body (comment + level optional)', () => {
      const { error } = approveInvoiceSchema.validate({});
      expect(error).toBeUndefined();
    });

    it('accepts a comment and approval level', () => {
      const { error, value } = approveInvoiceSchema.validate({ comment: 'looks good', approvalLevel: 2 });
      expect(error).toBeUndefined();
      expect(value.approvalLevel).toBe(2);
    });

    it('rejects an approval level below 1', () => {
      const { error } = approveInvoiceSchema.validate({ approvalLevel: 0 });
      expect(error).toBeDefined();
    });

    it('rejects a non-integer approval level', () => {
      const { error } = approveInvoiceSchema.validate({ approvalLevel: 1.5 });
      expect(error).toBeDefined();
    });
  });
});
