import type { EntitlementService } from './entitlement.service';

/**
 * The minimal tool shape this module needs to derive a module id. Kept structural (only `path`) so
 * `@aegis/db` does not depend on `@aegis/ai-core`; the real `AegisTool` from ai-core satisfies it.
 */
export interface ToolWithPath {
  path: string;
}

/**
 * Derives a module id from a tool's route path's FIRST segment, e.g. `/expense/api/v1/expenses/:id`
 * -> `"expense"`. Leading slashes are ignored; a pathless/empty path yields `""`.
 */
export function moduleIdFromTool(tool: ToolWithPath): string {
  const path = tool.path ?? '';
  const trimmed = path.replace(/^\/+/, '');
  const firstSlash = trimmed.indexOf('/');
  return firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash);
}

/**
 * Loads the SET of module ids the tenant currently has (enabled/active/not-expired) so the caller
 * can build ai-core's SYNCHRONOUS `isModuleEnabled` predicate. `filterToolsForPrincipal`'s
 * `isModuleEnabled` is synchronous and the entitlement lookup is async (a DB read under RLS), so the
 * two cannot be composed directly — the entitlement state must be pre-loaded once, then queried
 * synchronously per tool.
 *
 * Usage:
 * ```ts
 * const set = await entitledModuleIds(service);
 * const filtered = filterToolsForPrincipal(tools, {
 *   permissions,
 *   isModuleEnabled: (tool) => set.has(moduleIdFromTool(tool)),
 * });
 * ```
 */
export async function entitledModuleIds(service: EntitlementService): Promise<Set<string>> {
  return new Set(await service.listEnabledModuleIds());
}

/**
 * Builds an ASYNC per-tool entitlement predicate `(tool) => Promise<boolean>` from the service and a
 * tool→moduleId mapping (defaults to {@link moduleIdFromTool}).
 *
 * NOTE: `filterToolsForPrincipal`'s `isModuleEnabled` is SYNCHRONOUS, so this async predicate cannot
 * be passed to it directly. Prefer pre-loading the entitled set with {@link entitledModuleIds} and
 * passing a sync `tool => set.has(moduleIdOf(tool))` predicate. This async form is provided for
 * callers doing per-tool checks outside that filter (e.g. a single-tool execution-time gate), where
 * one DB round-trip per tool is acceptable.
 */
export function makeIsModuleEnabled(
  service: EntitlementService,
  toolToModuleId: (tool: ToolWithPath) => string = moduleIdFromTool,
): (tool: ToolWithPath) => Promise<boolean> {
  return (tool: ToolWithPath) => service.isModuleEnabled(toolToModuleId(tool));
}
