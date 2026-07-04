/** A minimal JSON Schema (Draft-07 subset) — the shape LLM function-calling / MCP expect for tool input. */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  format?: string;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  additionalProperties?: boolean;
  description?: string;
}

/**
 * One agent-callable tool, derived from a single guarded HTTP route. It is **authz-bound**: `permissions`
 * are the permission(s) the caller must hold (authorizeAny semantics — any one suffices), so the tool
 * registry handed to an agent can be pre-filtered per principal before the model ever sees it. The tool
 * is executed by calling the same guarded route a human hits (the agent never bypasses the governed core).
 */
export interface AegisTool {
  /** Deterministic id derived from method + path (e.g. `post_expense_api_v1_expenses`). */
  name: string;
  /** HTTP method (GET/POST/PUT/PATCH/DELETE). */
  method: string;
  /** Express route path (e.g. `/expense/api/v1/expenses/:id`). */
  path: string;
  /** Permission(s) required — caller must hold at least one. Empty is impossible (only guarded routes emit tools). */
  permissions: string[];
  /** Always true here — the generator only emits tools for auth-guarded routes. */
  requiresAuth: boolean;
  /** Merged JSON Schema for the tool input (params + query + body). */
  inputSchema: JsonSchema;
  /** Which request parts contributed to `inputSchema` (`params` | `query` | `body`). */
  inputSources: string[];
  /** Human/agent-facing description. Defaults to an improved imperative phrase; the module manifest can override it. */
  description: string;
  /** Optional governance risk tier from the module manifest: 1 (benign) … 4 (irreversible/material). */
  riskTier?: 1 | 2 | 3 | 4;
  /** Optional free-form classification tags from the module manifest, e.g. `["expense", "write"]`. */
  tags?: string[];
}

/** The generated registry for one service. */
export interface ToolRegistry {
  tools: AegisTool[];
}
