import type { AegisTool } from './types';

/** The inputs that decide which tools a given principal may be offered. */
export interface ToolFilterContext {
  /** Permissions the calling principal holds. A tool is authorized if it shares at least one (authorizeAny). */
  permissions: string[];
  /**
   * Entitlement gate: return true if the tenant/plan has the tool's module enabled. Omitted means "no
   * entitlement check" — every otherwise-authorized tool is treated as enabled.
   */
  isModuleEnabled?: (tool: AegisTool) => boolean;
}

/**
 * The pre-model authorization×entitlement filter: narrow a tool list to only the tools a given principal
 * is both allowed to use (authorization) AND whose module the tenant has (entitlement), so the agent is
 * never even offered a tool it cannot legitimately call. Deterministic and computed OUTSIDE the model —
 * "filter the tool list before the model ever sees it."
 *
 * IMPORTANT: this is a convenience/UX narrowing, not a security boundary. The PEP at execution time (the
 * same authz gate a human hits on the guarded route) remains the real gate — defense in depth. A tool that
 * slips past this filter must still be rejected at execution; a tool dropped here is simply never proposed.
 *
 * Pure: no side effects, no mutation of the input array, no new dependencies.
 */
export function filterToolsForPrincipal(tools: AegisTool[], ctx: ToolFilterContext): AegisTool[] {
  const held = new Set(ctx.permissions);
  return tools.filter((tool) => {
    // (a) authorization — caller must hold at least one of the tool's permissions (authorizeAny).
    const authorized = tool.permissions.some((p) => held.has(p));
    if (!authorized) return false;
    // (b) entitlement — if a gate is provided, the tool's module must be enabled for the tenant.
    if (ctx.isModuleEnabled && !ctx.isModuleEnabled(tool)) return false;
    return true;
  });
}
