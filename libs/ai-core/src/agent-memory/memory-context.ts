import type { AgentMemoryRecord, AgentMemoryStore } from './types';

/**
 * TIER-0 / TIER-1 MEMORY CONTEXT — the preamble that lets the agent KNOW THE TENANT without a tool
 * call (Wayfinder's MemoryContextProvider, re-homed onto the {@link AgentMemoryStore} seam):
 *
 *   Tier-0 — "[MEMORY] Known profile:" — the always-in-prompt core-memory block: live
 *   `kind = "profile"` facts, newest first, ≤ 40 items (the Letta pattern; ADR-0001).
 *
 *   Tier-1 — "Recent context:" — recency/salience: the most recently updated live memories of ANY
 *   kind, ≤ 10 items, minus anything already shown in the profile block.
 *
 *   (Tier-2 — vector recall — deliberately does NOT live here: it runs only when the model calls
 *   `memory_recall`; see memory-tools.ts.)
 *
 * Each item is exactly ONE line, char-capped so a single long note cannot blow the prompt budget —
 * memory grounding is a nudge, not a context dump.
 *
 * FAIL-SOFT + INERT-WHEN-EMPTY: an empty store OR a store failure returns "" so the caller's prompt
 * is byte-identical to a memory-less turn (the wrapper only prepends a non-blank block). This
 * function never throws.
 */

/** Hard caps for the two blocks (ADR-0001: profile ≤ ~40 items; salience is a short tail). */
export const PROFILE_MAX_ITEMS = 40;
export const SALIENT_MAX_ITEMS = 10;

/** Per-item character cap so one long memory cannot dominate the preamble. */
const ITEM_MAX_CHARS = 200;

export interface MemoryContextOptions {
  /** Max Tier-0 profile items (default {@link PROFILE_MAX_ITEMS}; hard-capped at it). */
  profileLimit?: number;
  /** Max Tier-1 recent items (default {@link SALIENT_MAX_ITEMS}; hard-capped at it). */
  salientLimit?: number;
}

/** One memory as a single prompt line: "- [subject|title: ]content", newline-free, char-capped. */
function itemLine(memory: AgentMemoryRecord): string {
  const label = (memory.subject ?? memory.title ?? '').trim();
  const body = memory.content.replace(/\s+/g, ' ').trim();
  const text = label && !body.toLowerCase().startsWith(label.toLowerCase()) ? `${label}: ${body}` : body;
  return `- ${text.slice(0, ITEM_MAX_CHARS)}`;
}

function clampLimit(requested: number | undefined, fallback: number, cap: number): number {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : fallback;
  return Math.min(cap, Math.max(0, n));
}

/**
 * Compose the Tier-0 + Tier-1 memory preamble for a turn, or "" when there is nothing to say (empty
 * store, zero limits, or a store failure — fail-soft, never throws).
 */
export async function buildMemoryContext(
  store: AgentMemoryStore,
  opts: MemoryContextOptions = {},
): Promise<string> {
  const profileLimit = clampLimit(opts.profileLimit, PROFILE_MAX_ITEMS, PROFILE_MAX_ITEMS);
  const salientLimit = clampLimit(opts.salientLimit, SALIENT_MAX_ITEMS, SALIENT_MAX_ITEMS);

  // Each tier degrades independently: a failing profile() read must not take Recent context with it.
  let profile: AgentMemoryRecord[] = [];
  let salient: AgentMemoryRecord[] = [];
  if (profileLimit > 0) {
    try {
      profile = (await store.profile(profileLimit)).slice(0, profileLimit);
    } catch {
      profile = []; // fail-soft: memory must never crash a turn
    }
  }
  if (salientLimit > 0) {
    try {
      salient = (await store.salient(salientLimit)).slice(0, salientLimit);
    } catch {
      salient = []; // fail-soft
    }
  }

  // Tier-1 minus what Tier-0 already shows (cheap id-set dedup; a repeat is tolerable, a dump is not).
  const shown = new Set(profile.map((m) => m.id));
  const recent = salient.filter((m) => !shown.has(m.id));

  const blocks: string[] = [];
  if (profile.length > 0) {
    blocks.push('Known profile:\n' + profile.map(itemLine).join('\n'));
  }
  if (recent.length > 0) {
    blocks.push('Recent context:\n' + recent.map(itemLine).join('\n'));
  }
  if (blocks.length === 0) return '';
  return `[MEMORY] ${blocks.join('\n\n')}`;
}
