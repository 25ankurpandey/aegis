import type { LlmChooseToolInput, LlmClient, LlmToolChoice } from './llm-client';

/**
 * The OpenAI-COMPATIBLE gateway adapter: an {@link LlmClient} that speaks the OpenAI `chat/completions`
 * function-calling protocol. This is the single adapter that covers OpenAI itself and every
 * OpenAI-compatible gateway — LiteLLM, OpenRouter, vLLM, etc. — by construction: they all accept the same
 * `tools`/`tool_calls` schema. Swap the provider by changing `baseUrl`/`model`, not the code.
 *
 * `fetchImpl` is injectable so tests exercise the request/response mapping with a canned fetch and never
 * touch the network.
 */

/** Construction options — where to POST, which model, and how to authenticate. */
export interface OpenAiCompatibleOptions {
  /** Gateway base URL, e.g. `https://api.openai.com/v1` or a LiteLLM proxy. `/chat/completions` is appended. */
  baseUrl: string;
  /** API key sent as `Authorization: Bearer`. */
  apiKey: string;
  /** Model id, e.g. `gpt-4o` or a LiteLLM route name. */
  model: string;
  /** Injectable fetch (defaults to global fetch) — lets tests feed canned responses offline. */
  fetchImpl?: typeof fetch;
}

/** Minimal shape of the pieces of an OpenAI `chat/completions` response we consume. */
interface OpenAiChatCompletion {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

export class OpenAiCompatibleLlmClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiCompatibleOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async chooseTool(input: LlmChooseToolInput): Promise<LlmToolChoice> {
    // Map each filtered tool to the OpenAI function-calling schema.
    const tools = input.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));

    // History first (provider-neutral role/content), then the current user message.
    const messages = [
      ...(input.history ?? []).map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: input.userMessage },
    ];

    const resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: this.model, messages, tools }),
    });

    const data = (await resp.json()) as OpenAiChatCompletion;
    const message = data.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.[0]?.function;

    // A tool_call wins: parse its JSON arguments into the tool's args.
    if (toolCall?.name) {
      let args: Record<string, unknown> = {};
      if (toolCall.arguments) {
        try {
          args = JSON.parse(toolCall.arguments) as Record<string, unknown>;
        } catch {
          /* malformed arguments — fall back to empty args; the core still validates at execution. */
        }
      }
      return { toolName: toolCall.name, args };
    }

    // Otherwise it's a plain assistant reply.
    return { assistantMessage: message?.content ?? '' };
  }
}
