import type { LlmChooseToolInput, LlmClient, LlmToolChoice } from '../orchestrator/llm-client';
import type { LlmProviderConfig } from './provider-types';

/**
 * THE MULTI-LLM GATEWAY: itself an {@link LlmClient}, so it drops straight into the orchestrator seam —
 * the governed core still sees ONE {@link LlmClient} and never learns there are several providers behind
 * it. Founder requirement satisfied here: MULTIPLE providers, PRIORITY-ordered, SELECTABLE
 * ({@link setActive}), runtime-SWITCHABLE ({@link setPriority}/{@link enable}/{@link disable}), with
 * FALLBACK on error.
 *
 * Routing for one {@link chooseTool} call:
 *   1. Build the ordered candidate list = enabled providers, sorted by priority ASC (ties → registration
 *      order). If an ACTIVE provider is set and enabled, it is pinned to the FRONT (the user's pin, like
 *      Wayfinder's ProviderChain), then the rest follow by priority, de-duplicated.
 *   2. Walk the list: try each provider's {@link LlmClient.chooseTool}; return the FIRST success and
 *      record which provider served it ({@link lastServedBy}).
 *   3. On a thrown error, FALL BACK to the next candidate. Throw an aggregated error only if ALL fail.
 *
 * Deterministic ordering is guaranteed: registration order is captured as a stable secondary key so
 * equal-priority providers never reorder between calls.
 */
export class LlmGateway implements LlmClient {
  /** Registered providers, in registration order (the stable secondary sort key). */
  private readonly providers: LlmProviderConfig[] = [];
  /** The explicitly-selected provider name, or undefined to route purely by priority. */
  private activeName?: string;
  /** Name of the provider that served the most recent successful {@link chooseTool}. */
  private lastServedByName?: string;

  /** Register (or replace, by name) a provider. Registration order is preserved for tie-breaking. */
  register(cfg: LlmProviderConfig): this {
    const existing = this.providers.findIndex((p) => p.name === cfg.name);
    if (existing >= 0) {
      this.providers[existing] = { ...cfg };
    } else {
      this.providers.push({ ...cfg });
    }
    return this;
  }

  /** All registered providers, in registration order (defensive copy). */
  listProviders(): LlmProviderConfig[] {
    return this.providers.map((p) => ({ ...p }));
  }

  /** Select an explicit ACTIVE provider (pinned to the front of routing). Throws if unknown. */
  setActive(name: string): this {
    if (!this.providers.some((p) => p.name === name)) {
      throw new Error(`LlmGateway: cannot setActive unknown provider "${name}"`);
    }
    this.activeName = name;
    return this;
  }

  /** The current active provider name, or undefined when routing purely by priority. */
  getActive(): string | undefined {
    return this.activeName;
  }

  /** Clear the explicit active selection — routing falls back to pure priority order. */
  clearActive(): this {
    this.activeName = undefined;
    return this;
  }

  /** The provider that served the most recent successful {@link chooseTool}, if any. */
  lastServedBy(): string | undefined {
    return this.lastServedByName;
  }

  /** Change a provider's priority at runtime. Throws if unknown. */
  setPriority(name: string, priority: number): this {
    this.mustGet(name).priority = priority;
    return this;
  }

  /** Enable a provider at runtime. Throws if unknown. */
  enable(name: string): this {
    this.mustGet(name).enabled = true;
    return this;
  }

  /** Disable a provider at runtime (skipped by both active-selection and fallback). Throws if unknown. */
  disable(name: string): this {
    this.mustGet(name).enabled = false;
    return this;
  }

  async chooseTool(input: LlmChooseToolInput): Promise<LlmToolChoice> {
    const candidates = this.orderedCandidates();
    if (candidates.length === 0) {
      throw new Error('LlmGateway: no enabled providers to route to');
    }

    const failures: string[] = [];
    for (const provider of candidates) {
      try {
        const result = await provider.client.chooseTool(input);
        this.lastServedByName = provider.name;
        return result;
      } catch (err) {
        failures.push(`${provider.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    throw new Error(`LlmGateway: all providers failed [${failures.join('; ')}]`);
  }

  /**
   * The ordered candidate list for one turn: enabled providers by priority ASC (ties → registration
   * order), with an enabled active provider pinned to the front, de-duplicated. A disabled active
   * selection is ignored (routing falls back to priority order).
   */
  private orderedCandidates(): LlmProviderConfig[] {
    const enabled = this.providers
      .map((p, index) => ({ p, index }))
      .filter((e) => e.p.enabled)
      .sort((a, b) => a.p.priority - b.p.priority || a.index - b.index)
      .map((e) => e.p);

    const active =
      this.activeName != null
        ? enabled.find((p) => p.name === this.activeName)
        : undefined;
    if (!active) return enabled;

    return [active, ...enabled.filter((p) => p.name !== active.name)];
  }

  private mustGet(name: string): LlmProviderConfig {
    const found = this.providers.find((p) => p.name === name);
    if (!found) throw new Error(`LlmGateway: unknown provider "${name}"`);
    return found;
  }
}
