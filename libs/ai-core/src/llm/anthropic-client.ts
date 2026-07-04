import type { LlmChooseToolInput, LlmClient, LlmToolChoice } from '../orchestrator/llm-client';

/**
 * The ANTHROPIC adapter: an {@link LlmClient} that speaks the Anthropic Messages REST API
 * (`POST /v1/messages`) function-calling protocol. This is the sibling of
 * {@link OpenAiCompatibleLlmClient} — where that one covers OpenAI/LiteLLM/OpenRouter/Groq via the
 * `chat/completions` shape, this one covers Anthropic's own `tool_use` shape. Both plug in behind the
 * same narrow {@link LlmClient} seam, so the governed core never sees a vendor SDK.
 *
 * No new dependency: we call the REST endpoint directly through an injectable `fetchImpl` (defaults to
 * global fetch), exactly as the OpenAI-compatible adapter does, so tests exercise the request/response
 * mapping with a canned fetch and never touch the network.
 */

/** Construction options — where to POST, which model, and how to authenticate. */
export interface AnthropicOptions {
  /** API key sent as the `x-api-key` header. */
  apiKey: string;
  /** Model id, e.g. `claude-opus-4-8` or `claude-sonnet-4-5`. */
  model: string;
  /** API base URL. Defaults to `https://api.anthropic.com`. `/v1/messages` is appended. */
  baseUrl?: string;
  /** Injectable fetch (defaults to global fetch) — lets tests feed canned responses offline. */
  fetchImpl?: typeof fetch;
  /** `max_tokens` for the response (Anthropic requires it). Defaults to 1024. */
  maxTokens?: number;
  /** `anthropic-version` header. Defaults to a pinned stable version. */
  anthropicVersion?: string;
}

/** Minimal shape of the pieces of an Anthropic Messages response we consume. */
interface AnthropicMessage {
  content?: Array<
    | { type: 'text'; text?: string }
    | { type: 'tool_use'; name?: string; input?: Record<string, unknown> }
    | { type: string; [k: string]: unknown }
  >;
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

export class AnthropicLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxTokens: number;
  private readonly anthropicVersion: string;

  constructor(opts: AnthropicOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.anthropicVersion = opts.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
  }

  async chooseTool(input: LlmChooseToolInput): Promise<LlmToolChoice> {
    // Map each filtered tool to the Anthropic tool-use schema (input_schema, not parameters).
    const tools = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

    // History first (provider-neutral role/content), then the current user message. Anthropic only
    // accepts `user`/`assistant` roles on messages, so any non-assistant role maps to `user`.
    const messages = [
      ...(input.history ?? []).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
      { role: 'user', content: input.userMessage },
    ];

    const resp = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, max_tokens: this.maxTokens, messages, tools }),
    });

    const data = (await resp.json()) as AnthropicMessage;
    const blocks = data.content ?? [];

    // A tool_use block wins: its `input` is already a parsed object (Anthropic returns structured args).
    const toolUse = blocks.find((b) => b.type === 'tool_use') as
      | { type: 'tool_use'; name?: string; input?: Record<string, unknown> }
      | undefined;
    if (toolUse?.name) {
      return { toolName: toolUse.name, args: toolUse.input ?? {} };
    }

    // Otherwise concatenate any text blocks into a plain assistant reply.
    const text = blocks
      .filter((b): b is { type: 'text'; text?: string } => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    return { assistantMessage: text };
  }
}
