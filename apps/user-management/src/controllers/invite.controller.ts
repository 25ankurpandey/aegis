import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { routeParam, validate } from '@aegis/service-core';
import { ApiConstants } from '@aegis/shared-constants';
import { Permission } from '@aegis/shared-enums';
import { authenticate, authorize } from '@aegis/access-control';
import { InviteService } from '../services/invite.service';
import { createInviteSchema, idParamSchema } from '../validators/admin-surface.validator';

/** Tenant invitation surface. */
@controller(`/user-management${ApiConstants.PublicPrefix}`)
export class InviteController {
  constructor(@inject(InviteService) private readonly invites: InviteService) {}

  @httpGet('/invites', authenticate(), authorize(Permission.UserInvite))
  async list(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.invites.list());
  }

  @httpPost('/invites', authenticate(), authorize(Permission.UserInvite), validate(createInviteSchema))
  async create(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.invites.create(req.body) });
  }

  @httpPost('/invites/:id/revoke', authenticate(), authorize(Permission.UserInvite), validate(idParamSchema, 'params'))
  async revoke(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.invites.revoke(routeParam(req, 'id')) });
  }
}
