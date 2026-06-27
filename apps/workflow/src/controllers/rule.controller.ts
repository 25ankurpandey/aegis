import type { Request, Response } from 'express';
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { validate } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import { authenticate, authorize } from '@aegis/access-control';
import { RuleService } from '../services/rule.service';
import { createRuleSchema, runRuleSchema } from '../validators/rule.validator';

/**
 * Rule authoring + dry-run HTTP surface — every route is PEP-guarded (authenticate → authorize);
 * request bodies validate via the `validate(...)` middleware (not inline in the handlers).
 */
@controller(`/workflow${ApiConstants.PublicPrefix}`)
export class RuleController {
  constructor(@inject(RuleService) private readonly rules: RuleService) {}

  @httpPost('/rules', authenticate(), authorize(Permission.RuleCreate), validate(createRuleSchema))
  async createRule(req: Request, res: Response): Promise<void> {
    res.status(201).json(await this.rules.createRule(req.body));
  }

  @httpGet('/rules', authenticate(), authorize(Permission.RuleView))
  async listRules(req: Request, res: Response): Promise<void> {
    const page = req.query['page'] ? Number(req.query['page']) : undefined;
    const pageSize = req.query['pageSize'] ? Number(req.query['pageSize']) : undefined;
    res.status(200).json(await this.rules.listRules(page, pageSize));
  }

  @httpGet('/rules/:id', authenticate(), authorize(Permission.RuleView))
  async getRule(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.rules.getRule(req.params['id']));
  }

  @httpPost('/rules/:id/run', authenticate(), authorize(Permission.RuleRun), validate(runRuleSchema))
  async runRule(req: Request, res: Response): Promise<void> {
    res.status(200).json(await this.rules.runRule(req.params['id'], req.body.facts, req.body.dryRun ?? false));
  }
}
