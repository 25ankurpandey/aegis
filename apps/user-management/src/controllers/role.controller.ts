import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { routeParam, validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { PapService } from '../services/pap.service';
import { createRoleSchema, assignRoleSchema } from '../validators/role.validator';

/**
 * Role surface (the PAP write side): list/create roles + assign a role to a user. Every route is
 * PEP-guarded (authenticate → authorize(permission)); request bodies validate via middleware.
 */
@controller(`/user-management${ApiConstants.PublicPrefix}`)
export class RoleController {
  constructor(@inject(PapService) private readonly pap: PapService) {}

  @httpGet('/roles', authenticate(), authorize(Permission.RoleView))
  async listRoles(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.pap.listRoles());
  }

  @httpPost('/roles', authenticate(), authorize(Permission.RoleCreate), validate(createRoleSchema))
  async createRole(req: Request, res: Response): Promise<void> {
    res.status(201).json(await this.pap.createRole(req.body));
  }

  @httpPost('/users/:userId/role', authenticate(), authorize(Permission.RoleAssign), validate(assignRoleSchema))
  async assignRole(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.pap.assignRole({ userId: routeParam(req, 'userId'), ...req.body }));
  }
}
