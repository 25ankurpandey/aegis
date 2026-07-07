import {
  MemoryToolNames,
  type AgentMemoryStore,
  type AgentRecallHit,
  type BuiltinTool,
} from './types';

/**
 * The THREE MEMORY TOOLS (Wayfinder's `memory_remember` / `memory_recall` / `memory_forget`) as
 * Aegis BUILT-IN tools. The LLM reasons about WHEN to remember/recall/forget; every handler here
 * only calls the injected {@link AgentMemoryStore} (the governed, RLS-scoped core the caller wires
 * in) — the model never touches storage directly.
 *
 * Tier-2 of the tiered-retrieval design lives here: vector recall runs ONLY when the model calls
 * `memory_recall` (Tier-0/Tier-1 are pre-composed into the prompt by `buildMemoryContext` and cost
 * no tool round-trip).
 *
 * DANGER FACTS: `memory_remember` / `memory_forget` are REVERSIBLE writes (supersession and forget
 * are both `valid_to` soft-invalidations — nothing is destroyed), so they declare
 * `writesData: true, riskTier: 2` and pass the gate as allow+log. `memory_recall` is a pure read
 * (tier 1). The orchestrator still runs these facts through the SAME `evaluateActionGate` as every
 * route-derived tool.
 *
 * FAIL-SOFT: a store failure never crashes the turn — every handler catches and returns
 * `{ ok: false, error }` so the model can carry on without the memory.
 */

/** Default cosine-similarity floor for `memory_recall` — below this a hit is noise, not memory. */
export const RECALL_DEFAULT_MIN_SCORE = 0.15;

/** Default / maximum hit counts for `memory_recall` (mirrors Wayfinder's k ∈ [1, 20], default 5). */
export const RECALL_DEFAULT_K = 5;
export const RECALL_MAX_K = 20;

/** The `kind` a memory defaults to when the model does not classify it. */
export const DEFAULT_MEMORY_KIND = 'note';

/** The kinds `memory_remember` accepts from the model; anything else falls back to "note". */
const REMEMBER_KINDS = new Set(['note', 'decision', 'profile']);

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The compact hit shape returned to the model (no metadata / embedding internals). */
function toToolHit(hit: AgentRecallHit): Record<string, unknown> {
  return {
    id: hit.id,
    kind: hit.kind,
    ...(hit.subject ? { subject: hit.subject } : {}),
    ...(hit.title ? { title: hit.title } : {}),
    content: hit.content,
    distance: hit.distance,
  };
}

/**
 * Build the three built-in memory tools over `store`. Pure factory — no state beyond the closure,
 * so a fresh set per turn/session is cheap and isolation stays wherever the store put it (RLS).
 */
export function makeMemoryTools(store: AgentMemoryStore): BuiltinTool[] {
  const remember: BuiltinTool = {
    definition: {
      name: MemoryToolNames.remember,
      description:
        'Store a durable memory for later turns/sessions. Use kind "decision" to journal a decision ' +
        'that was made, "profile" for durable user/tenant facts (always shown in future prompts), ' +
        'and "note" (default) for everything else. Provide "subject" as a stable key when the fact ' +
        'can change over time (e.g. "billing plan") — a new memory with the same subject replaces ' +
        'the old one.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The fact to remember, as one short sentence.' },
          subject: {
            type: 'string',
            description: 'Optional stable supersession key; same subject replaces the prior value.',
          },
          kind: {
            type: 'string',
            enum: ['note', 'decision', 'profile'],
            default: DEFAULT_MEMORY_KIND,
            description: 'note (default) | decision (decision journal) | profile (always-in-prompt).',
          },
          title: { type: 'string', description: 'Optional short title.' },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    dangerFacts: { writesData: true, riskTier: 2 },
    async execute(args) {
      const content = asTrimmedString(args.content);
      if (!content) return { ok: false, error: 'memory_remember requires a non-empty "content"' };
      const rawKind = asTrimmedString(args.kind);
      const kind = REMEMBER_KINDS.has(rawKind) ? rawKind : DEFAULT_MEMORY_KIND;
      const subject = asTrimmedString(args.subject);
      const title = asTrimmedString(args.title);
      try {
        const stored = await store.remember({
          kind,
          content,
          ...(subject ? { subject } : {}),
          ...(title ? { title } : {}),
        });
        return { ok: true, id: stored.id, kind, ...(subject ? { subject } : {}) };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  };

  const recall: BuiltinTool = {
    definition: {
      name: MemoryToolNames.recall,
      description:
        'Semantically search stored memories. Call this when the user refers to something from a ' +
        'past conversation that is not already in the [MEMORY] context.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in natural language.' },
          k: { type: 'number', description: `Max hits to return (default ${RECALL_DEFAULT_K}).` },
          kind: { type: 'string', description: 'Optional kind filter (e.g. "decision").' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    dangerFacts: { writesData: false, riskTier: 1 },
    async execute(args) {
      const query = asTrimmedString(args.query);
      if (!query) return { ok: false, error: 'memory_recall requires a non-empty "query"' };
      const rawK = typeof args.k === 'number' && Number.isFinite(args.k) ? Math.round(args.k) : RECALL_DEFAULT_K;
      const k = Math.min(RECALL_MAX_K, Math.max(1, rawK));
      const kind = asTrimmedString(args.kind);
      try {
        const hits = await store.recall(query, k, {
          minScore: RECALL_DEFAULT_MIN_SCORE,
          ...(kind ? { kind } : {}),
        });
        return { ok: true, hits: hits.map(toToolHit) };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  };

  const forget: BuiltinTool = {
    definition: {
      name: MemoryToolNames.forget,
      description:
        'Forget every stored memory with the given subject (reversible soft-invalidation). Use when ' +
        'the user asks to forget something, naming the subject the memory was stored under.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'The supersession key of the memories to forget.' },
        },
        required: ['subject'],
        additionalProperties: false,
      },
    },
    dangerFacts: { writesData: true, riskTier: 2 },
    async execute(args) {
      const subject = asTrimmedString(args.subject);
      if (!subject) return { ok: false, error: 'memory_forget requires a non-empty "subject"' };
      try {
        const forgotten = await store.forgetBySubject(subject);
        return { ok: true, forgotten };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
  };

  return [remember, recall, forget];
}
