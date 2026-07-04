import type { LlmClient } from '../orchestrator/llm-client';

/**
 * PROVIDER TYPES for the multi-LLM gateway (see {@link LlmGateway}). Founder requirement: MULTIPLE LLMs
 * configured, PRIORITY-ordered, SELECTABLE, and runtime-SWITCHABLE with FALLBACK.
 *
 * Pattern borrowed (not copied) from the parallel Wayfinder project's `ProviderChain` — a single ordered
 * registry where the user-selected primary is pinned to the front and the rest follow by priority, walked
 * with de-dup and per-hop failover, and adding a provider is one entry. Here we express that as a
 * registry of {@link LlmProviderConfig} the {@link LlmGateway} owns, plus a declarative
 * {@link LlmProviderSpec} that the factory ({@link buildLlmGateway}) turns into concrete clients.
 */

/**
 * A LIVE, registered provider inside the gateway: an already-constructed {@link LlmClient} with its
 * ordering/enablement metadata. Lower `priority` numbers are preferred (priority 1 beats priority 2).
 */
export interface LlmProviderConfig {
  /** Unique provider name used for selection/switching (e.g. "anthropic-primary", "groq-fallback"). */
  name: string;
  /** Selection order — LOWER wins. Ties are broken by registration order (see {@link LlmGateway}). */
  priority: number;
  /** When false the provider is skipped for both active-selection and fallback. */
  enabled: boolean;
  /** The constructed client this provider routes to. */
  client: LlmClient;
}

/** The kinds of client the factory ({@link buildLlmGateway}) knows how to construct. */
export type LlmProviderKind = 'openai-compatible' | 'anthropic';

/**
 * A DECLARATIVE provider spec (config-object shape) the factory turns into an {@link LlmProviderConfig}.
 * This is what lives in env/config (e.g. `AEGIS_LLM_PROVIDERS` JSON) — no client instances, just data, so
 * once keys are added the gateway lights up without code changes.
 */
export interface LlmProviderSpec {
  /** Unique provider name (see {@link LlmProviderConfig.name}). */
  name: string;
  /** Which client class to build. */
  kind: LlmProviderKind;
  /** Base URL. Required for `openai-compatible`; optional override for `anthropic`. */
  baseUrl?: string;
  /** API key for the provider. */
  apiKey?: string;
  /** Model id. */
  model: string;
  /** Selection order — LOWER wins. Defaults to registration order when omitted (see factory). */
  priority?: number;
  /** Defaults to true when omitted. */
  enabled?: boolean;
}
