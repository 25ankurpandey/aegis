import Joi from 'joi';

export const userContactParamSchema = Joi.object({
  id: Joi.string().uuid().required(),
});

export const recipientDirectoryQuerySchema = Joi.object({
  role: Joi.string().min(1).optional(),
  groupId: Joi.string().uuid().optional(),
  tenantAdmins: Joi.boolean().truthy('true').falsy('false').optional(),
}).xor('role', 'groupId', 'tenantAdmins');
