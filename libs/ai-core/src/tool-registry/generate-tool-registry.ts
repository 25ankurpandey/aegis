import type { Application } from 'express';
import { readPermissions, readSchema } from '@aegis/service-core';
import { joiToJsonSchema } from './joi-to-json-schema';
import { applyToolManifest, improveDescription, type ToolManifest } from './tool-manifest';
import type { AegisTool, JsonSchema, ToolRegistry } from './types';

export interface GenerateOptions {
  /** Route path prefixes to skip (infra surface). Default: the public/non-tool prefixes. */
  excludePaths?: string[];
  /** Per-service manifest that overrides description/riskTier/tags per route key. */
  manifest?: ToolManifest;
}

const DEFAULT_EXCLUDE = ['/health', '/api-docs', '/.well-known', '/favicon.ico'];

/** Merge order: params, then query, then body (body wins on key collisions). */
const SOURCE_ORDER = ['params', 'query', 'body'] as const;

interface RouteLayer {
  route?: {
    path: string | string[];
    methods?: Record<string, boolean>;
    stack?: Array<{ handle?: unknown }>;
  };
}

/**
 * Walk a built Express app's router and emit an authz-bound tool per guarded route. A route becomes a
 * tool only if it carries a `Permission` stamp (via `authorize()`); its input schema is recovered from
 * the `validate()` stamp(s). This is why the platform is self-sustaining: registering a new guarded
 * route makes the agent tool appear with zero extra wiring. Pure/synchronous + no side effects, so it's
 * trivially testable and can run at boot or on demand.
 *
 * IMPORTANT: the tool's `inputSchema` is best-effort context for the model — the real input gate remains
 * the `validate()` middleware at execution, and the real authz gate remains the PEP. The agent executes
 * a tool by calling the same guarded route a human hits; it never bypasses the governed core.
 */
export function generateToolRegistry(app: Application, opts: GenerateOptions = {}): ToolRegistry {
  const exclude = opts.excludePaths ?? DEFAULT_EXCLUDE;
  const stack = (app as unknown as { _router?: { stack?: RouteLayer[] } })._router?.stack ?? [];
  const tools: AegisTool[] = [];

  for (const layer of stack) {
    const route = layer.route;
    if (!route) continue;
    const paths = Array.isArray(route.path) ? route.path : [route.path];
    for (const path of paths) {
      if (path === '*' || exclude.some((p) => path.startsWith(p))) continue;

      // Aggregate the permission + schema stamps across the route's handler stack.
      let permissions: string[] | undefined;
      const schemas: Array<{ schema: import('joi').ObjectSchema; source: string }> = [];
      for (const s of route.stack ?? []) {
        const p = readPermissions(s.handle);
        if (p && !permissions) permissions = p;
        const sc = readSchema(s.handle);
        if (sc) schemas.push(sc);
      }
      if (!permissions || permissions.length === 0) continue; // only authz-bound routes are tools

      const methods = route.methods
        ? Object.keys(route.methods).filter((m) => route.methods?.[m])
        : ['all'];
      const inputSources = uniquePresentSources(schemas);
      const inputSchema = mergeSchemas(schemas);

      for (const method of methods) {
        const base: AegisTool = {
          name: toolName(method, path),
          method: method.toUpperCase(),
          path,
          permissions,
          requiresAuth: true,
          inputSchema,
          inputSources,
          // Better default than the raw "METHOD path"; the manifest can still override it below.
          description: improveDescription(method, path),
        };
        tools.push(applyToolManifest(base, opts.manifest));
      }
    }
  }
  return { tools };
}

function mergeSchemas(schemas: Array<{ schema: import('joi').ObjectSchema; source: string }>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const source of SOURCE_ORDER) {
    for (const entry of schemas.filter((s) => s.source === source)) {
      const js = joiToJsonSchema(entry.schema);
      Object.assign(properties, js.properties ?? {});
      for (const key of js.required ?? []) {
        if (!required.includes(key)) required.push(key);
      }
    }
  }
  const out: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) out.required = required;
  return out;
}

function uniquePresentSources(schemas: Array<{ source: string }>): string[] {
  return SOURCE_ORDER.filter((s) => schemas.some((x) => x.source === s));
}

/** Deterministic, collision-resistant tool id from method + path. */
function toolName(method: string, path: string): string {
  const slug = path
    .replace(/^\/+/, '')
    .replace(/\/:?/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/_$/, '');
  return `${method.toLowerCase()}_${slug}`;
}
