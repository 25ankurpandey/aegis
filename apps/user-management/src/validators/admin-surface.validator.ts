import Joi from 'joi';
import { Scope } from '@aegis/shared-enums';

const email = Joi.string().email({ tlds: { allow: false } });

export const idParamSchema = Joi.object({
  id: Joi.string().uuid().required(),
});

export const createPolicySchema = Joi.object({
  permission: Joi.string().min(3).required(),
  effect: Joi.string().valid('allow', 'deny').required(),
  rule: Joi.object().unknown(true).optional(),
  priority: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().optional(),
});

export const updatePolicySchema = Joi.object({
  permission: Joi.string().min(3).optional(),
  effect: Joi.string().valid('allow', 'deny').optional(),
  rule: Joi.object().unknown(true).optional(),
  priority: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

export const createInviteSchema = Joi.object({
  email: email.required(),
  roleId: Joi.string().uuid().optional(),
  scope: Joi.string()
    .valid(...Object.values(Scope))
    .optional(),
  teamIds: Joi.array().items(Joi.string().uuid()).optional(),
  expiresAt: Joi.string().isoDate().optional(),
});
