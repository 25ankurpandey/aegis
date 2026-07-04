import { randomUUID } from 'node:crypto';
import type { Application } from 'express';
import { generateToolRegistry, type GenerateOptions } from '../tool-registry/generate-tool-registry';
import { filterToolsForPrincipal, type ToolFilterContext } from '../tool-registry/filter-tools';
import type { AegisTool, JsonSchema } from '../tool-registry/types';

/**
 * The tool SERVER layer over the tool REGISTRY: list the tools a principal may use, and INVOKE one.
 *
 * The load-bearing property: `invokeTool` executes a tool by calling **the same guarded HTTP route a
 * human hits** (Bearer token + tenant header), so the call goes through the real
 * `context → authenticate → authorize(PEP) → validate → RLS → handler → audit` chain. The agent never
 * bypasses the governed core — it is a new *principal* and a new *interface*, exactly per the platform
 * principle "the agent reasons; the governed core acts." The `inputSchema` a tool advertises is
 * best-effort context for the model; the real gates remain the PEP (authz) and `validate()` (input) at
 * execution time.
 */

/** Convenience: generate the registry from a live app and filter it for a principal in one call. */
export function listToolsForPrincipal(
  app: Application,
  ctx: ToolFilterContext,
  opts?: GenerateOptions,
): AegisTool[] {
  return filterToolsForPrincipal(generateToolRegistry(app, opts).tools, ctx);
}

/** Where/how to reach the governed service, and as whom, when invoking a tool. */
export interface InvokeContext {
  /** Base URL of the running service, e.g. `http://127.0.0.1:4002`. */
  baseUrl: string;
  /** The caller's bearer JWT (the human's token, or an On-Behalf-Of / delegated agent token). */
  token: string;
  /** The tenant the call runs in (must match the token's tenant — the core re-checks this). */
  tenantId: string;
  /** Correlation id for tracing/audit; generated if omitted. */
  correlationId?: string;
  /** Injectable fetch (defaults to global fetch) — lets tests point at an ephemeral server. */
  fetchImpl?: typeof fetch;
}

export interface InvokeResult {
  status: number;
  ok: boolean;
  body: unknown;
}

/**
 * Invoke a tool by calling its guarded route over HTTP. Path params (`:id`) are filled from `args`;
 * remaining args go to the JSON body for write methods, or the query string for GET/HEAD. Auth + tenant
 * headers are attached so the governed core authenticates/authorizes/validates exactly as for a human.
 */
export async function invokeTool(
  tool: AegisTool,
  args: Record<string, unknown>,
  ctx: InvokeContext,
): Promise<InvokeResult> {
  const doFetch = ctx.fetchImpl ?? fetch;

  const pathParams = new Set<string>();
  const path = tool.path.replace(/:([A-Za-z0-9_]+)/g, (_m, name: string) => {
    pathParams.add(name);
    return encodeURIComponent(String(args[name] ?? ''));
  });

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!pathParams.has(k)) rest[k] = v;
  }

  const method = tool.method.toUpperCase();
  const usesBody = method !== 'GET' && method !== 'HEAD';
  let url = ctx.baseUrl.replace(/\/+$/, '') + path;

  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.token}`,
    'x-tenant-id': ctx.tenantId,
    'x-correlation-id': ctx.correlationId ?? randomUUID(),
  };

  let body: string | undefined;
  const restKeys = Object.keys(rest);
  if (usesBody && restKeys.length > 0) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(rest);
  } else if (!usesBody && restKeys.length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) qs.set(k, String(v));
    url += (url.includes('?') ? '&' : '?') + qs.toString();
  }

  const resp = await doFetch(url, { method, headers, body });
  const text = await resp.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON response — keep raw text */
  }
  return { status: resp.status, ok: resp.ok, body: parsed };
}

/** An MCP-shaped tool definition (name/description/inputSchema) — the bridge to an MCP server. */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** Map an Aegis tool to the MCP `tools/list` shape (dependency-free; the MCP server wraps this). */
export function toMcpToolDefinition(tool: AegisTool): McpToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}
