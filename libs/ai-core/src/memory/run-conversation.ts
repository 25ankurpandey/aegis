import { runAgentTurn, type AegisTurnResult, type RunAgentTurnParams } from '../orchestrator/agent-orchestrator';
import { sessionKey, type ConversationStore, type ConversationTurn } from './conversation-store';

/**
 * MEMORY WRAPPER around {@link runAgentTurn}: it does NOT touch the orchestrator (governance stays where
 * it is). Instead it (1) loads prior history for the session key, (2) threads it into the turn as
 * `history`, and (3) records the user message + a compact record of the outcome back into the store.
 *
 * Isolation lives in the key ({@link sessionKey}), never in this logic — two sessions/tenants using this
 * wrapper cannot see each other's history because they resolve to different keys.
 */

/** Inputs to a memory-backed turn. `turnParams` is everything {@link runAgentTurn} needs EXCEPT `history`. */
export interface RunConversationParams {
  store: ConversationStore;
  tenantId: string;
  sessionId: string;
  /** The {@link RunAgentTurnParams} minus `history` — history is supplied by the store. */
  turnParams: Omit<RunAgentTurnParams, 'history'>;
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
  const { store, tenantId, sessionId, turnParams } = params;
  const key = sessionKey(tenantId, sessionId);

  const prior = await store.history(key);
  const history = prior.map((t) => ({ role: t.role, content: t.content }));

  const result = await runAgentTurn({ ...turnParams, history });

  const now = Date.now();
  await store.append(key, { role: 'user', content: turnParams.userMessage, at: now });
  await store.append(key, outcomeTurn(result, now));

  return result;
}
