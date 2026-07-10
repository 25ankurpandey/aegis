import { runAgentTurn, type AegisTurnResult, type RunAgentTurnParams } from '../orchestrator/agent-orchestrator';
import { sessionKey, type ConversationStore, type ConversationTurn } from './conversation-store';
import type { AgentMemoryStore } from '../agent-memory/types';
import { makeMemoryTools } from '../agent-memory/memory-tools';
import { buildMemoryContext } from '../agent-memory/memory-context';

/**
 * MEMORY WRAPPER around {@link runAgentTurn}: it does NOT touch the orchestrator (governance stays where
 * it is). Instead it (1) loads prior history for the session key, (2) threads it into the turn as
 * `history`, and (3) records the user message + a compact record of the outcome back into the store.
 *
 * Isolation lives in the key ({@link sessionKey}), never in this logic — two sessions, two users, or two
 * tenants using this wrapper cannot see each other's history because they resolve to different keys. In
 * particular (MEM-04) two DIFFERENT users who share the same `(tenantId, sessionId)` still get different
 * keys because `userId` is folded into the key, so one user can never read another's transcript.
 *
 * LONG-TERM AGENT MEMORY (optional, additive): pass {@link RunConversationParams.agentMemory} to give
 * the turn Wayfinder-style tiered memory on top of the raw transcript — the Tier-0/Tier-1
 * `[MEMORY]` preamble ({@link buildMemoryContext}) is prepended as a `system` context message, and the
 * three built-in memory tools ({@link makeMemoryTools}) are offered so the model can remember / recall /
 * forget through the RLS-scoped store the caller injected. Fail-soft: an empty or failing memory store
 * leaves the turn byte-identical to a memory-less one.
 */

/** Optional long-term agent memory wiring for a turn. */
export interface AgentMemoryOptions {
  /** The governed (RLS-scoped) memory store — tenant isolation lives in the store the caller injects. */
  store: AgentMemoryStore;
  /** Prepend the Tier-0/Tier-1 `[MEMORY]` preamble as a system context message. Default true. */
  injectContext?: boolean;
}

/** Inputs to a memory-backed turn. `turnParams` is everything {@link runAgentTurn} needs EXCEPT `history`. */
export interface RunConversationParams {
  store: ConversationStore;
  tenantId: string;
  /**
   * The principal the transcript is bound to (MEM-04). REQUIRED — folded into the session key so two
   * users sharing a `(tenantId, sessionId)` never collide. A user-less caller (service account, system
   * job) must pass an explicit sentinel id here, never a blank string.
   */
  userId: string;
  sessionId: string;
  /** The {@link RunAgentTurnParams} minus `history` — history is supplied by the store. */
  turnParams: Omit<RunAgentTurnParams, 'history'>;
  /** Optional long-term memory: memory tools + tiered context over an injected {@link AgentMemoryStore}. */
  agentMemory?: AgentMemoryOptions;
}

/** Reduce a completed turn to a single compact record for the conversation log. */
function outcomeTurn(result: AegisTurnResult, at: number): ConversationTurn {
  switch (result.kind) {
    case 'message':
      return { role: 'assistant', content: result.text, at };
    case 'refused':
      return { role: 'assistant', content: `[refused] ${result.reason}`, at };
    case 'needs_ceremony':
      return {
        role: 'assistant',
        content: `[needs_ceremony:${result.decision.ceremony}] ${result.toolName}`,
        at,
      };
    case 'tool':
      return {
        role: 'tool',
        content: `${result.toolName} -> ${result.result.status}${result.result.ok ? ' ok' : ''}`,
        at,
      };
  }
}

/**
 * Run one memory-backed agent turn. Loads history for the session, runs the governed turn with it, then
 * appends the user message and a compact outcome record. Returns the {@link AegisTurnResult} unchanged.
 */
export async function runConversation(params: RunConversationParams): Promise<AegisTurnResult> {
  const { store, tenantId, userId, sessionId, turnParams, agentMemory } = params;
  const key = sessionKey(tenantId, userId, sessionId);

  const prior = await store.history(key);
  let history = prior.map((t) => ({ role: t.role, content: t.content }));

  let builtinTools = turnParams.builtinTools;
  if (agentMemory) {
    // Offer the three memory tools ON TOP of any builtins the caller already passed (per-turn, so
    // the tools always close over the caller's RLS-scoped store — never a cached one).
    builtinTools = [...(turnParams.builtinTools ?? []), ...makeMemoryTools(agentMemory.store)];

    if (agentMemory.injectContext !== false) {
      // Tier-0/Tier-1 preamble as a per-turn SYSTEM context message. buildMemoryContext is fail-soft
      // ("" on empty store or store error), and a blank block is NOT injected — a memory-less turn
      // stays byte-identical to today's. The preamble is never persisted to the conversation record.
      const memoryBlock = await buildMemoryContext(agentMemory.store);
      if (memoryBlock) history = [{ role: 'system', content: memoryBlock }, ...history];
    }
  }

  const result = await runAgentTurn({
    ...turnParams,
    ...(builtinTools ? { builtinTools } : {}),
    history,
  });

  const now = Date.now();
  await store.append(key, { role: 'user', content: turnParams.userMessage, at: now });
  await store.append(key, outcomeTurn(result, now));

  return result;
}
