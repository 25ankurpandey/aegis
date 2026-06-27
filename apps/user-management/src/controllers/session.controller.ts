import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpDelete, httpGet } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { ApiConstants } from '@aegis/shared-constants';
import { Permission } from '@aegis/shared-enums';
import { authenticate, authorize } from '@aegis/access-control';
import { SessionService } from '../services/session.service';
import { idParamSchema } from '../validators/admin-surface.validator';

/** Session read/revoke surface for the reference IdP. */
@controller(`/user-management${ApiConstants.PublicPrefix}`)
export class SessionController {
  constructor(@inject(SessionService) private readonly sessions: SessionService) {}

  @httpGet('/sessions', authenticate(), authorize(Permission.SessionView))
  async list(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.sessions.list());
  }

  @httpDelete('/sessions/:id', authenticate(), authorize(Permission.SessionRevoke), validate(idParamSchema, 'params'))
  async revoke(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.sessions.revoke(req.params['id']) });
  }
}
