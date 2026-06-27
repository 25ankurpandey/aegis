import Joi from 'joi';

const email = Joi.string().email({ tlds: { allow: false } });

/** Joi schemas for the auth surface (register/login). Applied via the `validate(...)` middleware. */
export const registerSchema = Joi.object({
  email: email.required(),
  password: Joi.string().min(8).required(),
  firstName: Joi.string().optional(),
  lastName: Joi.string().optional(),
});

export const loginSchema = Joi.object({
  email: email.required(),
  password: Joi.string().required(),
});
