import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPut } from 'inversify-express-utils';
import { routeParam, validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { TenantConfigService } from '../services/tenant-config.service';
import { setConfigSchema, setFlagSchema } from '../validators/tenant-config.validator';

/**
 * Tenant config + feature-flag surface (SPEC §11.5). Reads gated by tenant.view, mutations by
 * tenant.manage. Every route is PEP-guarded (authenticate → authorize(permission)); bodies validate
 * via middleware.
 */
@controller(`/user-management${ApiConstants.PublicPrefix}/tenant`)
export class TenantConfigController {
  constructor(@inject(TenantConfigService) private readonly svc: TenantConfigService) {}

  @httpGet('/config', authenticate(), authorize(Permission.TenantView))
  async listConfig(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.svc.listConfig());
  }

  @httpPut('/config/:key', authenticate(), authorize(Permission.TenantManage), validate(setConfigSchema))
  async setConfig(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.svc.setConfig({ key: routeParam(req, 'key'), value: req.body.value }));
  }

  @httpGet('/features', authenticate(), authorize(Permission.TenantView))
  async listFeatures(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.svc.listFeatures());
  }

  @httpPut('/features/:flag', authenticate(), authorize(Permission.TenantManage), validate(setFlagSchema))
  async setFlag(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.svc.setFlag({ flag: routeParam(req, 'flag'), enabled: req.body.enabled }));
  }
}
