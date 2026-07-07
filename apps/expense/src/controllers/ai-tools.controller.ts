import type { Request, Response } from 'express';
import { controller, httpGet } from 'inversify-express-utils';
import { authenticate } from '@aegis/access-control';
import { Config } from '@aegis/service-core';
import { ApiConstants } from '@aegis/shared-constants';
import { generateToolRegistry, type AegisTool } from '@aegis/ai-core';
import { EntitlementService, entitledModuleIds, moduleIdFromTool } from '@aegis/db';

/**
 * LIVE pay-per-module entitlement gate for the AI tool surface, behind the env flag
 * `AEGIS_ENTITLEMENT_FILTER === "on"`. When ON it pre-loads the caller-tenant's entitled module set
 * (one RLS-scoped read) and returns the SYNC per-tool predicate `filterToolsForPrincipal` expects;
 * when OFF it returns `undefined` (no entitlement narrowing).
 *
 * DEFAULT OFF — deliberately fail-open: a tenant with no `tenant_modules` rows (i.e. every tenant
 * that predates billing ingestion) would otherwise lose EVERY tool the moment this shipped. Flip the
 * flag on only once Chargebee ingestion has populated entitlements. This is a convenience/UX
 * narrowing, not the security boundary — the PEP on each tool's own guarded route remains the real
 * gate either way.
 *
 * Exported for ai-act.controller.ts, which applies the SAME gate at invocation time — so listing
 * and invocation honor entitlements identically.
 */
export async function entitlementGate(
  req: Request,
): Promise<((tool: AegisTool) => boolean) | undefined> {
  if (Config.get('AEGIS_ENTITLEMENT_FILTER') !== 'on') return undefined; // default OFF (fail-open)
  const tenantId = req.principal?.tenantId;
  if (!tenantId) return () => false; // flag ON but no tenant resolvable — fail closed
  const ids = await entitledModuleIds(new EntitlementService({ tenantId }));
  return (tool: AegisTool) => ids.has(moduleIdFromTool(tool));
}

/**
 * AI capability surface for this service: the auto-generated, authz-bound tool registry an agent uses to
 * discover what it can do here. The registry is derived from this service's OWN live routes (route-walk +
 * the `Permission` stamped by `authorize()` + the Joi schema stamped by `validate()`), so it stays in
 * lockstep with the code with zero manual wiring — add a guarded route and its tool appears here for free
 * (the self-sustaining property). Each tool carries its required `permissions`; the agent runtime applies
 * `filterToolsForPrincipal` with the caller's effective (Casbin-resolved) permissions before offering
 * them to the model, and executes a tool by calling the same guarded route a human hits.
 *
 * When the entitlement flag is ON the listing is additionally narrowed to the tenant's entitled
 * modules (see {@link entitlementGate}), mirroring the same gate `POST /act` applies at invocation.
 *
 * This route itself is `authenticate()`-only (a catalog read, not a mutation) and carries no permission
 * stamp, so it never lists itself as a tool.
 */
@controller(`/expense${ApiConstants.PublicPrefix}/_ai`)
export class AiToolsController {
  /** List this service's agent tool registry (capability catalog), entitlement-narrowed when the flag is on. */
  @httpGet('/tools', authenticate())
  async listTools(req: Request, res: Response): Promise<void> {
    const registry = generateToolRegistry(req.app);
    const isModuleEnabled = await entitlementGate(req);
    const tools = isModuleEnabled ? registry.tools.filter(isModuleEnabled) : registry.tools;
    res.status(200).json({ data: { tools } });
  }
}
