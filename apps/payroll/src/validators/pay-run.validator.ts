import Joi from 'joi';
import { PayRunType, PayslipStatus } from '@aegis/shared-enums';

/** Joi schema for the pay-run surface (create pay-run). Applied via the `validate(...)` middleware. */
export const createPayRunSchema = Joi.object({
  periodStart: Joi.string().isoDate().required(),
  periodEnd: Joi.string().isoDate().required(),
  payDate: Joi.string().isoDate().required(),
  type: Joi.string()
    .valid(...Object.values(PayRunType))
    .optional(),
  payCalendarId: Joi.string().uuid().optional(),
  employeeIds: Joi.array().items(Joi.string().uuid()).optional(),
});

/**
 * Decide body for the engine-backed POST /pay-runs/:id/decisions: the required terminal `decision`
 * (approved|rejected) + an optional comment recorded on the immutable approval vote.
 */
export const decideSchema = Joi.object({
  decision: Joi.string().valid('approved', 'rejected').required(),
  comment: Joi.string().optional(),
});

/** Approve body (backward-compatible alias for decide{decision:'approved'}): an optional comment. */
export const approveSchema = Joi.object({
  comment: Joi.string().optional(),
});

export const payRunIdParamSchema = Joi.object({
  id: Joi.string().uuid().required(),
});

export const payslipListQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(200).optional(),
  payRunId: Joi.string().uuid().optional(),
  employeeId: Joi.string().uuid().optional(),
  status: Joi.string()
    .valid(...Object.values(PayslipStatus))
    .optional(),
});
