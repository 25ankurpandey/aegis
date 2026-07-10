import type { LlmToolDefinition } from '../orchestrator/llm-client';

/**
 * AGENT MEMORY — the structural seam between the orchestrator's memory surface (tools + tiered prompt
 * context + post-turn extraction) and the governed store that actually persists memories.
 *
 * Ported from Wayfinder's cross-device memory architecture (ADR-0001: tiered retrieval, the three
 * memory tools, the mem0 write path) onto Aegis' "the agent reasons; the governed core acts" split:
 * everything in this directory REASONS about memory; every actual read/write goes through an injected
 * {@link AgentMemoryStore} whose implementation owns tenant isolation (RLS in `@aegis/db`'s
 * AppBrainService). Nothing here imports `@aegis/db` — the seam is STRUCTURAL, mirroring the v2
 * app-brain contract exactly, so the caller wires `new AppBrainService(...)` straight in and an
 * in-memory fake satisfies the same interface for offline tests.
 *
 * FAIL-SOFT is a load-bearing invariant across the module: a memory failure must NEVER crash a turn.
 * Tools return `{ ok: false, error }`, the context builder returns `""`, and the extractor returns
 * `[]` / skips — log-and-continue semantics everywhere.
 */

/**
 * Input to {@link AgentMemoryStore.remember} — mirrors the v2 `RememberInput` structurally.
 * `subject` is the SUPERSESSION key: a non-blank subject soft-invalidates every live memory of the
 * same tenant with the same trimmed, lowercased subject before inserting (so "where the car is
 * parked" always has exactly one live value). Blank/absent subject supersedes nothing.
 */
export interface AgentRememberInput {
  kind: string;
  /** Stable external key within (tenant, kind); when non-null the write upserts on it. */
  ref?: string | null;
  /** Supersession key: non-blank ⇒ soft-invalidate prior live rows with the same subject. */
  subject?: string | null;
  title?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
  importance?: number | null;
  /**
   * Visibility scope (mirrors the v2 store's `RememberInput.scope`): `private` (DEFAULT — owner-only)
   * or `team` (tenant-shared). The OWNER itself is never supplied here — the store binds the acting
   * user at construction (RLS/owner scoping), so a tool can request sharing but not spoof ownership.
   */
  scope?: 'private' | 'team';
}

/**
 * One live memory as read back from the store — the structural subset of the v2 `AppBrainMemory`
 * this module needs. Optional fields stay optional so both the RLS-backed row (which has them all)
 * and a minimal in-memory fake satisfy the shape.
 */
export interface AgentMemoryRecord {
  id: string;
  kind: string;
  subject?: string | null;
  ref?: string | null;
  title?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
  importance?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A recall result: a memory plus its cosine DISTANCE from the query (smaller = closer). */
export interface AgentRecallHit extends AgentMemoryRecord {
  distance: number;
}

/**
 * The v2 app-brain contract, verbatim (signatures MUST stay in lockstep with
 * `@aegis/db` AppBrainService — that class is the production implementation of this seam):
 *
 *   - `remember` — supersede-by-subject (soft-invalidate `valid_to = now()`), then insert.
 *   - `recall` — same-vector-space live rows only; `minScore` is cosine SIMILARITY in [0,1],
 *      applied as `distance <= 1 - minScore`.
 *   - `forget` — soft-invalidate ONE row by id (reversible; the row survives with `valid_to` set).
 *   - `forgetBySubject` — soft-invalidate ALL live rows with that subject; blank subject ⇒ 0.
 *   - `profile` — live `kind = "profile"` rows, newest updated first (the Tier-0 block).
 *   - `salient` — most recently updated live rows of ANY kind (the Tier-1 block).
 */
export interface AgentMemoryStore {
  remember(input: AgentRememberInput): Promise<AgentMemoryRecord>;
  recall(
    query: string,
    k?: number,
    opts?: { kind?: string; minScore?: number },
  ): Promise<AgentRecallHit[]>;
  forget(id: string): Promise<boolean>;
  forgetBySubject(subject: string): Promise<number>;
  profile(limit?: number): Promise<AgentMemoryRecord[]>;
  salient(limit?: number): Promise<AgentMemoryRecord[]>;
}

/** The canonical names of the three built-in memory tools (Wayfinder's tool surface, verbatim). */
export const MemoryToolNames = {
  remember: 'memory_remember',
  recall: 'memory_recall',
  forget: 'memory_forget',
} as const;

export type MemoryToolName = (typeof MemoryToolNames)[keyof typeof MemoryToolNames];

/**
 * Danger facts a BUILT-IN tool declares STATICALLY (never derived from model output). Built-ins do
 * not go over HTTP, so there is no method/path to derive from — the tool tells the gate what it is:
 *
 *   - `writesData` — true iff executing mutates state. Memory writes are reversible
 *     soft-invalidations, so `writesData: true` floors the risk tier at 2 (reversible write) but
 *     does not by itself force a ceremony.
 *   - `riskTier` — the static blast-radius tier (1 read · 2 reversible write · 3 external/notify ·
 *     4 money/irreversible). The orchestrator runs these facts through the SAME
 *     `evaluateActionGate` as route-derived tools: tier ≤ 2 ⇒ allow+log, tier 3 ⇒ confirm,
 *     tier 4 ⇒ second approver.
 */
export interface BuiltinDangerFacts {
  writesData: boolean;
  riskTier?: number;
}

/**
 * A BUILT-IN tool: offered to the model alongside the route-derived registry, but executed
 * IN-PROCESS by the orchestrator (never via `invokeTool`/HTTP). It still runs through the danger
 * gate first — a non-`allow` ceremony surfaces `needs_ceremony` and `execute` is never called. A
 * builtin can NEVER shadow a registry tool: on a name collision the registry wins.
 */
export interface BuiltinTool {
  definition: LlmToolDefinition;
  dangerFacts: BuiltinDangerFacts;
  execute(args: Record<string, unknown>): Promise<unknown>;
}
