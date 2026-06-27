import Joi from 'joi';

/** Joi schemas for the expense-report surface (create + attach-item + submit + approve + reject + reimburse). Applied via the `validate(...)` middleware. */
export const createReportSchema = Joi.object({
  name: Joi.string().min(1).required(),
  currency: Joi.string().length(3).optional(),
});

export const attachExpenseSchema = Joi.object({
  expenseId: Joi.string().uuid().optional(),
  amount: Joi.number().integer().optional(),
  currency: Joi.string().length(3).optional(),
  merchant: Joi.string().optional(),
  incurredOn: Joi.string().isoDate().optional(),
  description: Joi.string().optional(),
  categoryId: Joi.string().uuid().optional(),
  receiptRef: Joi.string().optional(),
  reportId: Joi.string().uuid().optional(),
}).or('expenseId', 'amount');

export const submitSchema = Joi.object({
  note: Joi.string().optional(),
});

export const approveSchema = Joi.object({
  comment: Joi.string().optional(),
});

/**
 * Decide body for the engine-backed POST /reports/:id/decisions: the required terminal `decision`
 * (approved|rejected) + an optional comment recorded on the vote + the report's decision row.
 */
export const decideSchema = Joi.object({
  decision: Joi.string().valid('approved', 'rejected').required(),
  comment: Joi.string().optional(),
});

/** Reject body: an optional reason recorded on the decision row, the activity, and the emitted event. */
export const rejectSchema = Joi.object({
  reason: Joi.string().optional(),
  comment: Joi.string().optional(),
});

/** Reimburse body: an optional comment recorded on the activity. */
export const reimburseSchema = Joi.object({
  comment: Joi.string().optional(),
});

/** Add-comment body: the required free-text comment body (W3-13b). */
export const addCommentSchema = Joi.object({
  body: Joi.string().min(1).required(),
});

/** Recall body: an optional reason recorded on the ReportRecalled activity (W3-13c). */
export const recallSchema = Joi.object({
  reason: Joi.string().optional(),
  comment: Joi.string().optional(),
});
