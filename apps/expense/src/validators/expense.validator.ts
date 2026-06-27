import Joi from 'joi';

/** Joi schema for the expense-item surface (add a standalone item). Applied via the `validate(...)` middleware. */
export const createExpenseSchema = Joi.object({
  amount: Joi.number().integer().required(), // integer minor units
  currency: Joi.string().length(3).optional(),
  merchant: Joi.string().optional(),
  incurredOn: Joi.string().isoDate().optional(),
  description: Joi.string().optional(),
  categoryId: Joi.string().uuid().optional(),
  receiptRef: Joi.string().optional(),
  reportId: Joi.string().uuid().optional(),
});

export const expenseIdParamSchema = Joi.object({
  id: Joi.string().uuid().required(),
});
