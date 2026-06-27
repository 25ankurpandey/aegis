import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost, httpPut } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { Permission, ConnectorKind } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import type { WorkflowShape } from '@aegis/shared-types';
import { authenticate, authorize } from '@aegis/access-control';
import { ConnectorAdminService } from '../services/connector-admin.service';
import {
  connectorKindParamSchema,
  reconcileConnectorSchema,
  syncStateParamSchema,
  syncStateQuerySchema,
  upsertConnectorConfigSchema,
} from '../validators/connector.validator';

/** Connector admin HTTP surface: per-tenant config, health, and durable sync-state views. */
@controller(`/workflow${ApiConstants.PublicPrefix}`)
export class ConnectorController {
  constructor(@inject(ConnectorAdminService) private readonly connectors: ConnectorAdminService) {}

  @httpGet('/connectors', authenticate(), authorize(Permission.ConnectorManage))
  async listConfigs(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.connectors.listConfigs());
  }

  @httpPut(
    '/connectors/:kind',
    authenticate(),
    authorize(Permission.ConnectorManage),
    validate(connectorKindParamSchema, 'params'),
    validate(upsertConnectorConfigSchema),
  )
  async upsertConfig(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.connectors.upsertConfig(req.params['kind'] as ConnectorKind, req.body));
  }

  @httpGet(
    '/connectors/sync-state',
    authenticate(),
    authorize(Permission.ConnectorPush),
    validate(syncStateQuerySchema, 'query'),
  )
  async listSyncState(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.connectors.listSyncState(req.query as WorkflowShape.ConnectorSyncStateQuery));
  }

  @httpGet(
    '/connectors/sync-state/:idempotencyKey',
    authenticate(),
    authorize(Permission.ConnectorPush),
    validate(syncStateParamSchema, 'params'),
  )
  async getSyncState(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.connectors.getSyncState(req.params['idempotencyKey']) });
  }

  @httpPost(
    '/connectors/reconcile',
    authenticate(),
    authorize(Permission.ConnectorPush),
    validate(reconcileConnectorSchema),
  )
  async reconcile(req: Request, res: Response): Promise<void> {
    res.status(202).json(await this.connectors.reconcile(req.body));
  }

  @httpGet(
    '/connectors/:kind/health',
    authenticate(),
    authorize(Permission.ConnectorManage),
    validate(connectorKindParamSchema, 'params'),
  )
  async health(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.connectors.health(req.params['kind'] as ConnectorKind) });
  }
}
