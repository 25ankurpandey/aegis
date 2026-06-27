import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpDelete, httpGet, httpPatch, httpPost } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { ApiConstants } from '@aegis/shared-constants';
import { Permission } from '@aegis/shared-enums';
import { authenticate, authorize } from '@aegis/access-control';
import { PolicyService } from '../services/policy.service';
import { createPolicySchema, idParamSchema, updatePolicySchema } from '../validators/admin-surface.validator';

/** ABAC policy PAP surface. */
@controller(`/user-management${ApiConstants.PublicPrefix}`)
export class PolicyController {
  constructor(@inject(PolicyService) private readonly policies: PolicyService) {}

  @httpGet('/policies', authenticate(), authorize(Permission.PolicyView))
  async list(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.policies.list());
  }

  @httpPost('/policies', authenticate(), authorize(Permission.PolicyManage), validate(createPolicySchema))
  async create(req: Request, res: Response): Promise<void> {
    res.status(201).json({ data: await this.policies.create(req.body) });
  }

  @httpPatch(
    '/policies/:id',
    authenticate(),
    authorize(Permission.PolicyManage),
    validate(idParamSchema, 'params'),
    validate(updatePolicySchema),
  )
  async update(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: await this.policies.update(req.params['id'], req.body) });
  }

  @httpDelete('/policies/:id', authenticate(), authorize(Permission.PolicyManage), validate(idParamSchema, 'params'))
  async delete(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.policies.delete(req.params['id']));
  }
}
