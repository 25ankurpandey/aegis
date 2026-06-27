import Joi from 'joi';

/** Joi schemas for the tenant config + feature-flag surface. Applied via the `validate(...)` middleware. */
export const setConfigSchema = Joi.object({
  value: Joi.any().required(),
});

export const setFlagSchema = Joi.object({
  enabled: Joi.boolean().required(),
});
