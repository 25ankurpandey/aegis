import { createDefinitionSchema, specSchema } from '../../src/validators/report-definition.validator';

describe('report-definition validators', () => {
  describe('specSchema', () => {
    it('defaults measures/dimensions/filters to empty arrays', () => {
      const { error, value } = specSchema.validate({});
      expect(error).toBeUndefined();
      expect(value.measures).toEqual([]);
      expect(value.dimensions).toEqual([]);
      expect(value.filters).toEqual([]);
    });

    it('accepts a well-formed measure/dimension/filter', () => {
      const { error } = specSchema.validate({
        measures: [{ name: 'total', agg: 'sum', field: 'amount' }],
        dimensions: [{ name: 'month', field: 'created_at', grain: 'month' }],
        filters: [{ field: 'status', op: 'eq', value: 'approved' }],
        grain: 'month',
        source: 'invoices',
      });
      expect(error).toBeUndefined();
    });

    it('rejects a measure missing its field', () => {
      const { error } = specSchema.validate({ measures: [{ name: 'total', agg: 'sum' }] });
      expect(error).toBeDefined();
    });
  });

  describe('createDefinitionSchema', () => {
    it('accepts a valid definition', () => {
      const { error, value } = createDefinitionSchema.validate({
        name: 'Monthly Spend',
        spec: { measures: [{ name: 'total', agg: 'sum', field: 'amount' }] },
      });
      expect(error).toBeUndefined();
      expect(value.name).toBe('Monthly Spend');
      // spec defaults are applied through the nested schema
      expect(value.spec.dimensions).toEqual([]);
    });

    it('rejects a name shorter than 2 chars', () => {
      const { error } = createDefinitionSchema.validate({ name: 'x', spec: {} });
      expect(error).toBeDefined();
    });

    it('requires name and spec', () => {
      const { error } = createDefinitionSchema.validate({});
      expect(error).toBeDefined();
    });
  });
});
