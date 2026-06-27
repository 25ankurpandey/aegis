import Joi from 'joi';
import { ReportRunStatus } from '@aegis/shared-enums';

/** Joi schema for enqueuing a report run. Applied via the `validate(...)` middleware in the route decorator. */
export const createRunSchema = Joi.object({
  definitionId: Joi.string().uuid().required(),
  params: Joi.object().unknown(true).default({}),
});

export const idParamSchema = Joi.object({
  id: Joi.string().uuid().required(),
});

export const listRunsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(200).default(50),
  definitionId: Joi.string().uuid().optional(),
  status: Joi.string()
    .valid(...Object.values(ReportRunStatus))
    .optional(),
});

export const createScheduleSchema = Joi.object({
  definitionId: Joi.string().uuid().required(),
  cron: Joi.string().min(3).required(),
  timezone: Joi.string().default('UTC'),
  enabled: Joi.boolean().default(true),
});

export const listSchedulesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(200).default(50),
  definitionId: Joi.string().uuid().optional(),
  enabled: Joi.boolean().optional(),
});

export const updateScheduleSchema = Joi.object({
  cron: Joi.string().min(3).optional(),
  timezone: Joi.string().optional(),
  enabled: Joi.boolean().optional(),
}).min(1);
