import Joi from 'joi';

/** Joi schema for the employee surface (create employee). Applied via the `validate(...)` middleware. */
export const createEmployeeSchema = Joi.object({
  userId: Joi.string().uuid().optional(),
  workJurisdiction: Joi.string().min(2).required(),
  residenceJurisdiction: Joi.string().optional(),
  personRef: Joi.string().uuid().optional(),
  employmentStatus: Joi.string().optional(),
  bankAccount: Joi.string().optional(),
  nationalId: Joi.string().optional(),
});
