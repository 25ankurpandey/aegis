import Joi from 'joi';
import { Scope } from '@aegis/shared-enums';

/** Joi schemas for the role surface (create role + assign role). Applied via the `validate(...)` middleware. */
export const createRoleSchema = Joi.object({
  name: Joi.string().min(2).required(),
  description: Joi.string().optional(),
  permissions: Joi.array().items(Joi.string()).min(1).required(),
});

export const assignRoleSchema = Joi.object({
  roleId: Joi.string().uuid().required(),
  scope: Joi.string()
    .valid(...Object.values(Scope))
    .optional(),
});
