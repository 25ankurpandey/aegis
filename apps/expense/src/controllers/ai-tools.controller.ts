import type { Request, Response } from 'express';
import { controller, httpGet } from 'inversify-express-utils';
import { authenticate } from '@aegis/access-control';
import { ApiConstants } from '@aegis/shared-constants';
import { generateToolRegistry } from '@aegis/ai-core';

/**
 * AI capability surface for this service: the auto-generated, authz-bound tool registry an agent uses to
 * discover what it can do here. The registry is derived from this service's OWN live routes (route-walk +
 * the `Permission` stamped by `authorize()` + the Joi schema stamped by `validate()`), so it stays in
 * lockstep with the code with zero manual wiring — add a guarded route and its tool appears here for free
 * (the self-sustaining property). Each tool carries its required `permissions`; the agent runtime applies
 * `filterToolsForPrincipal` with the caller's effective (Casbin-resolved) permissions before offering
 * them to the model, and executes a tool by calling the same guarded route a human hits.
 *
 * This route itself is `authenticate()`-only (a catalog read, not a mutation) and carries no permission
 * stamp, so it never lists itself as a tool.
 */
@controller(`/expense${ApiConstants.PublicPrefix}/_ai`)
export class AiToolsController {
  /** List this service's agent tool registry (capability catalog). */
  @httpGet('/tools', authenticate())
  listTools(req: Request, res: Response): void {
    const registry = generateToolRegistry(req.app);
    res.status(200).json({ data: registry });
  }
}
