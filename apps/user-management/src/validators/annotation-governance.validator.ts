import Joi from 'joi';
import { ErrUtils } from '@aegis/service-core';
import { ApprovalRecordType } from '@aegis/shared-enums';

export const createTeamSchema = Joi.object({
  name: Joi.string().min(2).required(),
  description: Joi.string().allow('').optional(),
});

export const updateTeamSchema = Joi.object({
  name: Joi.string().min(2).optional(),
  description: Joi.string().allow('', null).optional(),
  is_active: Joi.boolean().optional(),
}).min(1);

export const addTeamMemberSchema = Joi.object({
  userId: Joi.string().uuid().required(),
  role: Joi.string().optional(),
});

export const setTeamTagsSchema = Joi.object({
  tagIds: Joi.array().items(Joi.string().uuid()).required(),
});

export const createTagSchema = Joi.object({
  name: Joi.string().min(1).required(),
  color: Joi.string().max(16).optional(),
});

export const updateTagSchema = Joi.object({
  name: Joi.string().min(1).optional(),
  color: Joi.string().max(16).allow('', null).optional(),
  is_active: Joi.boolean().optional(),
}).min(1);

export const attachRecordTagSchema = Joi.object({
  tagId: Joi.string().uuid().required(),
});

export const assignRecordSchema = Joi.object({
  assigneeId: Joi.string().uuid().allow(null).required(),
});

export function parseRecordType(raw: string): ApprovalRecordType {
  if (Object.values(ApprovalRecordType).includes(raw as ApprovalRecordType)) {
    return raw as ApprovalRecordType;
  }
  throw ErrUtils.validation(`Unsupported record type '${raw}'`);
}
