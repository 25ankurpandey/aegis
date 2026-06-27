import Joi from 'joi';
import { ConnectorKind, ConnectorSyncStatus } from '@aegis/shared-enums';

export const connectorKindParamSchema = Joi.object({
  kind: Joi.string()
    .valid(...Object.values(ConnectorKind))
    .required(),
});

export const syncStateParamSchema = Joi.object({
  idempotencyKey: Joi.string().min(1).required(),
});

export const upsertConnectorConfigSchema = Joi.object({
  active: Joi.boolean().optional(),
  baseUrl: Joi.string().uri({ scheme: ['http', 'https'] }).optional().allow(null),
  credentialsRef: Joi.string().min(1).optional().allow(null),
  settings: Joi.object().unknown(true).optional(),
});

export const syncStateQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).optional(),
  pageSize: Joi.number().integer().min(1).max(200).optional(),
  kind: Joi.string()
    .valid(...Object.values(ConnectorKind))
    .optional(),
  status: Joi.string()
    .valid(...Object.values(ConnectorSyncStatus))
    .optional(),
});

export const reconcileConnectorSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(500).optional(),
});
