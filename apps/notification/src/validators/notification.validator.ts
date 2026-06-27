import Joi from 'joi';
import { EmailNotificationStatus } from '@aegis/shared-enums';

/**
 * Joi schemas for the in-app inbox surface (list query + the read-mark id param). Applied via the
 * shared `validate(schema, source)` middleware in the route decorators (NOT inline in handlers).
 */
export const listQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(200).optional(),
});

export const emailLogQuerySchema = listQuerySchema.keys({
  status: Joi.string()
    .valid(...Object.values(EmailNotificationStatus))
    .optional(),
  userId: Joi.string().uuid().optional(),
});

export const idParamSchema = Joi.object({
  id: Joi.string().uuid().required(),
});
