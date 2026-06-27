import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { ApiConstants } from '@aegis/shared-constants';
import { Permission } from '@aegis/shared-enums';
import { authenticate, authorize } from '@aegis/access-control';
import { TenantService } from '../services/tenant.service';
import { idParamSchema } from '../validators/admin-surface.validator';

/** Tenant and tenant-scoped user read surface. */
@controller(`/user-management${ApiConstants.PublicPrefix}`)
export class TenantController {
  constructor(@inject(TenantService) private readonly tenants: TenantService) {}

  @httpGet('/tenants/current', authenticate(), authorize(Permission.TenantView))
  async currentTenant(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.tenants.getCurrentTenant() });
  }

  @httpGet('/users', authenticate(), authorize(Permission.UserView))
  async listUsers(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.tenants.listUsers());
  }

  @httpGet('/users/:id', authenticate(), authorize(Permission.UserView), validate(idParamSchema, 'params'))
  async getUser(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.tenants.getUser(req.params['id']) });
  }
}
