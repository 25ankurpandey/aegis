import type { LlmClient } from '../orchestrator/llm-client';
import { OpenAiCompatibleLlmClient } from '../orchestrator/openai-compatible-client';
import { AnthropicLlmClient } from './anthropic-client';
import { LlmGateway } from './llm-gateway';
import type { LlmProviderSpec } from './provider-types';

/**
 * THE FACTORY: turns declarative {@link LlmProviderSpec}s (config/env data) into a live
 * {@link LlmGateway} with concrete clients. This is the "adding a provider is one config entry" seam —
 * `openai-compatible` → {@link OpenAiCompatibleLlmClient} (OpenAI/LiteLLM/OpenRouter/Groq), `anthropic` →
 * {@link AnthropicLlmClient}. Once keys land in env the gateway lights up with no code change.
 */

/** Construct the concrete {@link LlmClient} for one spec kind. */
function buildClient(spec: LlmProviderSpec): LlmClient {
  switch (spec.kind) {
    case 'anthropic':
      return new AnthropicLlmClient({
        apiKey: spec.apiKey ?? '',
        model: spec.model,
        baseUrl: spec.baseUrl,
      });
    case 'openai-compatible':
      return new OpenAiCompatibleLlmClient({
        baseUrl: spec.baseUrl ?? '',
        apiKey: spec.apiKey ?? '',
        model: spec.model,
      });
    default: {
      // Exhaustiveness guard — a new kind must be handled above.
      const exhaustive: never = spec.kind;
      throw new Error(`buildLlmGateway: unknown provider kind "${String(exhaustive)}"`);
    }
  }
}

/**
 * Build a {@link LlmGateway} from an ordered list of specs. Each spec's `priority` defaults to its index
 * (so declaration order IS priority order unless overridden), and `enabled` defaults to true. If
 * `opts.activeName` is given it is pinned as the active provider.
 */
export function buildLlmGateway(
  specs: LlmProviderSpec[],
  opts?: { activeName?: string },
): LlmGateway {
  const gateway = new LlmGateway();
  specs.forEach((spec, index) => {
    gateway.register({
      name: spec.name,
      priority: spec.priority ?? index,
      enabled: spec.enabled ?? true,
      client: buildClient(spec),
    });
  });
  if (opts?.activeName) gateway.setActive(opts.activeName);
  return gateway;
}

/**
 * Read provider specs from the environment. Two supported shapes, checked in order:
 *
 *   1. `AEGIS_LLM_PROVIDERS` — a JSON array of {@link LlmProviderSpec} (the full multi-provider config).
 *      Example:
 *        AEGIS_LLM_PROVIDERS='[
 *          {"name":"anthropic","kind":"anthropic","apiKey":"sk-ant-…","model":"claude-opus-4-8","priority":1},
 *          {"name":"groq","kind":"openai-compatible","baseUrl":"https://api.groq.com/openai/v1",
 *           "apiKey":"gsk_…","model":"llama-3.3-70b-versatile","priority":2}
 *        ]'
 *
 *   2. The existing single-provider env — `AEGIS_LLM_BASE_URL` / `AEGIS_LLM_API_KEY` / `AEGIS_LLM_MODEL`
 *      — mapped to ONE `openai-compatible` provider named "default". This keeps the pre-existing
 *      single-provider deployment working unchanged.
 *
 * Returns an empty array when neither is configured (the gateway then has no providers until one is set).
 */
export function readLlmProviderSpecsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LlmProviderSpec[] {
  const json = env.AEGIS_LLM_PROVIDERS?.trim();
  if (json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new Error(
        `readLlmProviderSpecsFromEnv: AEGIS_LLM_PROVIDERS is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error('readLlmProviderSpecsFromEnv: AEGIS_LLM_PROVIDERS must be a JSON array');
    }
    return parsed as LlmProviderSpec[];
  }

  const baseUrl = env.AEGIS_LLM_BASE_URL?.trim();
  const model = env.AEGIS_LLM_MODEL?.trim();
  if (baseUrl && model) {
    return [
      {
        name: 'default',
        kind: 'openai-compatible',
        baseUrl,
        apiKey: env.AEGIS_LLM_API_KEY?.trim() ?? '',
        model,
      },
    ];
  }

  return [];
}
