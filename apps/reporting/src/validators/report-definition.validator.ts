import Joi from 'joi';

/**
 * Joi schemas for the report-definition surface. Applied via the `validate(...)` middleware in the
 * route decorators. The `spec` is validated structurally as data (measures/dimensions/filters/grain)
 * — it is never raw SQL.
 */
export const specSchema = Joi.object({
  measures: Joi.array()
    .items(Joi.object({ name: Joi.string().required(), agg: Joi.string().required(), field: Joi.string().required() }))
    .default([]),
  dimensions: Joi.array()
    .items(Joi.object({ name: Joi.string().required(), field: Joi.string().required(), grain: Joi.string().optional() }))
    .default([]),
  filters: Joi.array()
    .items(Joi.object({ field: Joi.string().required(), op: Joi.string().required(), value: Joi.any() }))
    .default([]),
  grain: Joi.string().optional(),
  source: Joi.string().optional(),
});

export const createDefinitionSchema = Joi.object({
  name: Joi.string().min(2).required(),
  spec: specSchema.required(),
  requiredPermission: Joi.string().optional(),
});
