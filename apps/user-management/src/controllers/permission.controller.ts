import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet } from 'inversify-express-utils';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { PapService } from '../services/pap.service';

/** Permission surface (the PAP read side): list the global permission catalog. PEP-guarded. */
@controller(`/user-management${ApiConstants.PublicPrefix}`)
export class PermissionController {
  constructor(@inject(PapService) private readonly pap: PapService) {}

  @httpGet('/permissions', authenticate(), authorize(Permission.PermissionView))
  async listPermissions(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.pap.listPermissions());
  }
}
