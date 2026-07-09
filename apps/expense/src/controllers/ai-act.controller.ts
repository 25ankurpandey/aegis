import type { Request, Response } from 'express';
import { controller, httpPost } from 'inversify-express-utils';
import { authenticate } from '@aegis/access-control';
import { routeParam } from '@aegis/service-core';
import { ApiConstants } from '@aegis/shared-constants';
import { generateToolRegistry } from '@aegis/ai-core';
import {
  SupervisedActionBroker,
  InMemoryPendingActionStore,
  type CeremonyEvidence,
} from '@aegis/ai-core';
import { entitlementGate } from './ai-tools.controller';

/**
 * The running SUPERVISED ACTION surface for this service: the two-step danger-gated write flow an agent
 * drives. `POST /act` proposes a tool + args — the broker computes the danger decision and either runs it
 * straight through the governed route (an `allow`) or persists the pending action and surfaces the
 * ceremony the human must complete. `POST /act/:id/confirm` executes a proposed action once the human's
 * ceremony evidence proves the challenge was met. The broker is MODULE-LEVEL so a pending action survives
 * between the two requests.
 *
 * Both routes are `authenticate()`-only — the real authz gate stays on the tool's OWN guarded route,
 * which the broker calls (via invokeTool) using the caller's bearer + tenant, so the governed core still
 * authenticates → authorizes(PEP) → validates → RLS → audits exactly as for a human.
 */
const broker = new SupervisedActionBroker({ store: new InMemoryPendingActionStore() });

@controller(`/expense${ApiConstants.PublicPrefix}/_ai`)
export class AiActController {
  /** Propose a danger-gated action: gate it, then either run it (allow) or return the pending ceremony. */
  @httpPost('/act', authenticate())
  async act(req: Request, res: Response): Promise<void> {
    const body = req.body as { toolName?: string; args?: Record<string, unknown> };
    const registry = generateToolRegistry(req.app);
    const tool = registry.tools.find((t) => t.name === body.toolName);
    // Entitlement gate (flag-guarded, default OFF — see entitlementGate in ai-tools.controller.ts):
    // the SAME predicate that narrows GET /tools runs here, so a tool whose module the tenant is not
    // entitled to is indistinguishable from an unknown tool — listing and invocation stay identical.
    const isModuleEnabled = await entitlementGate(req);
    if (!tool || (isModuleEnabled && !isModuleEnabled(tool))) {
      res.status(404).json({ error: { message: `unknown tool "${body.toolName ?? ''}"` } });
      return;
    }

    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const invoke = {
      baseUrl: `${req.protocol}://${req.get('host')}`,
      token,
      tenantId: String(req.headers['x-tenant-id'] ?? ''),
    };

    const result = await broker.propose({
      tool,
      args: body.args ?? {},
      invoke,
      // Agent-initiated (AGENT-02): isAgent → a level-≥2 write escalates to a human second_approver
      // that the agent cannot self-satisfy with a confirm/typed-confirm it fabricates.
      gateContext: { approverPoolSize: undefined, isAgent: true },
    });
    res.status(200).json({ data: result });
  }

  /** Confirm a previously-proposed action with the human's ceremony evidence; executes it if satisfied. */
  @httpPost('/act/:id/confirm', authenticate())
  async confirm(req: Request, res: Response): Promise<void> {
    const body = req.body as { evidence?: CeremonyEvidence };
    const result = await broker.confirm({
      pendingId: routeParam(req, 'id'),
      evidence: body.evidence ?? {},
    });
    res.status(200).json({ data: result });
  }
}
