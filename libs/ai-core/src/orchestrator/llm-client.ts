/**
 * The LLM-GATEWAY SEAM: a provider-agnostic interface the orchestrator reasons through, so no vendor
 * SDK ever leaks into the governed core. Any provider — Anthropic, OpenAI, an OpenAI-compatible gateway
 * such as LiteLLM/OpenRouter, or a local stub in tests — plugs in behind {@link LlmClient}.
 *
 * The seam is deliberately narrow: the model is shown ONLY the pre-filtered tool list (see
 * `filterToolsForPrincipal`) and returns EITHER a single tool choice OR a plain assistant message. It
 * never executes anything — the orchestrator, not the model, drives every tool call through the guarded
 * route. This keeps "the agent reasons; the governed core acts" true at the type level.
 */

/** The model's decision for one turn: pick a tool (with args), or reply in natural language. */
export interface LlmToolChoice {
  /** The name of the tool the model chose. Absent when the model chose to reply instead. */
  toolName?: string;
  /** Arguments the model produced for the chosen tool (must match the tool's `inputSchema`). */
  args?: Record<string, unknown>;
  /** A natural-language reply, when the model chose not to call a tool. */
  assistantMessage?: string;
}

/** A prior conversation turn, for multi-turn context (kept provider-neutral: role + content strings). */
export interface LlmHistoryMessage {
  role: string;
  content: string;
}

/** The (filtered) tool the model is allowed to see for a turn — the MCP `tools/list` shape. */
export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** Inputs to a single {@link LlmClient.chooseTool} call. */
export interface LlmChooseToolInput {
  userMessage: string;
  /** ONLY the tools the principal may use — the model must never be shown more than this. */
  tools: LlmToolDefinition[];
  history?: LlmHistoryMessage[];
}

/**
 * The provider-agnostic LLM gateway. One method: given the user's message and the filtered tool list,
 * decide on a tool call or a reply. Implementations must be side-effect free w.r.t. the governed core —
 * they only talk to the model provider, never to the guarded routes.
 */
export interface LlmClient {
  chooseTool(input: LlmChooseToolInput): Promise<LlmToolChoice>;
}
