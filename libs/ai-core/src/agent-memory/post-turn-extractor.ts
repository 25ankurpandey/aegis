import type { LlmClient } from '../orchestrator/llm-client';
import type { AgentMemoryStore } from './types';
import { DEFAULT_MEMORY_KIND } from './memory-tools';

/**
 * The MEM0 WRITE PATH (ADR-0001): ASYNC POST-TURN EXTRACTION. After a turn completes, the LLM reads
 * the transcript and decides — per candidate fact — ADD / UPDATE / DELETE / NOOP, each with a
 * confidence. Proactive writes are CONFIDENCE-GATED (default floor 0.7) so the store does not fill
 * with guesses; explicit `memory_remember` tool calls remain the immediate write path and bypass
 * this entirely.
 *
 * Division of labor, per the platform principle: the LLM only PROPOSES ops (strict JSON, parsed
 * fail-soft); {@link applyMemoryOps} is the only code that ACTS, and it acts exclusively through the
 * injected {@link AgentMemoryStore} (RLS-scoped by the caller). UPDATE needs no special machinery —
 * the store's supersede-by-subject makes an UPDATE a natural remember with the same subject.
 *
 * FAIL-SOFT: a provider error, malformed JSON, or a store failure never throws out of here — the
 * extractor returns `[]`, the applier counts the op as skipped, and the turn already finished
 * unaffected (this runs OFF the turn's critical path).
 */

/** One proposed memory operation, as emitted by the extraction model. */
export interface MemoryOp {
  op: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
  /** Supersession key (required for DELETE; recommended for facts that change over time). */
  subject?: string;
  /** The fact text (required for ADD/UPDATE). */
  content?: string;
  /** Memory kind (note/decision/profile/...); defaults to "note" at apply time. */
  kind?: string;
  /** The model's confidence in this op, 0..1. Ops below the applier's floor are skipped. */
  confidence: number;
}

/** Confidence floor below which a proposed op is NOT applied (mem0's confidence gate). */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

const OPS = new Set<MemoryOp['op']>(['ADD', 'UPDATE', 'DELETE', 'NOOP']);

const EXTRACTION_INSTRUCTIONS = [
  'You are a memory-extraction engine. Read the conversation transcript below and decide which',
  'durable facts should be remembered, updated, or deleted in the assistant\'s long-term memory.',
  'Respond with STRICT JSON ONLY: a (possibly empty) array of operations, no prose, no markdown.',
  'Each operation is an object: {"op": "ADD" | "UPDATE" | "DELETE" | "NOOP",',
  ' "subject": string (stable key; required for DELETE), "content": string (required for ADD/UPDATE),',
  ' "kind": "note" | "decision" | "profile", "confidence": number between 0 and 1}.',
  'Only extract durable facts, decisions, and preferences — never transient chit-chat.',
  '',
  'TRANSCRIPT:',
].join('\n');

/** Strip an optional markdown code fence and return the first JSON array found in `raw`. */
function extractJsonArray(raw: string): string {
  const unfenced = raw.replace(/```(?:json)?/gi, '').trim();
  const start = unfenced.indexOf('[');
  const end = unfenced.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return '';
  return unfenced.slice(start, end + 1);
}

/** Validate one parsed element into a {@link MemoryOp}, or null when malformed (dropped, not fatal). */
function toMemoryOp(value: unknown): MemoryOp | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const op = typeof v.op === 'string' ? (v.op.toUpperCase() as MemoryOp['op']) : undefined;
  if (!op || !OPS.has(op)) return null;
  const confidence = typeof v.confidence === 'number' && Number.isFinite(v.confidence) ? v.confidence : NaN;
  if (Number.isNaN(confidence)) return null;
  const out: MemoryOp = { op, confidence };
  if (typeof v.subject === 'string' && v.subject.trim()) out.subject = v.subject.trim();
  if (typeof v.content === 'string' && v.content.trim()) out.content = v.content.trim();
  if (typeof v.kind === 'string' && v.kind.trim()) out.kind = v.kind.trim();
  return out;
}

/**
 * Ask `llm` for the memory ops implied by `turns`. Returns `[]` for an empty transcript, a provider
 * failure, or unparseable output; individually malformed elements are dropped, valid ones kept.
 */
export async function extractMemoryOps(
  llm: LlmClient,
  turns: ReadonlyArray<{ role: string; content: string }>,
): Promise<MemoryOp[]> {
  if (turns.length === 0) return [];
  const transcript = turns.map((t) => `${t.role}: ${t.content}`).join('\n');

  let raw: string;
  try {
    // No tools offered: the extraction model must ANSWER (strict JSON), not act.
    const choice = await llm.chooseTool({
      userMessage: `${EXTRACTION_INSTRUCTIONS}\n${transcript}`,
      tools: [],
    });
    raw = choice.assistantMessage ?? '';
  } catch {
    return []; // fail-soft: extraction is best-effort, off the critical path
  }

  const json = extractJsonArray(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map(toMemoryOp).filter((op): op is MemoryOp => op !== null);
}

/**
 * Apply extracted ops through the store. ADD/UPDATE ⇒ `store.remember` (supersede-by-subject makes
 * UPDATE natural); DELETE ⇒ `store.forgetBySubject`; NOOP, sub-floor confidence, structurally
 * incomplete ops, and store failures ⇒ skipped. Never throws.
 */
export async function applyMemoryOps(
  store: AgentMemoryStore,
  ops: ReadonlyArray<MemoryOp>,
  opts?: { minConfidence?: number },
): Promise<{ applied: number; skipped: number }> {
  const minConfidence = opts?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  let applied = 0;
  let skipped = 0;

  for (const op of ops) {
    if (op.op === 'NOOP' || !(op.confidence >= minConfidence)) {
      skipped += 1;
      continue;
    }
    try {
      if (op.op === 'ADD' || op.op === 'UPDATE') {
        const content = op.content?.trim();
        if (!content) {
          skipped += 1;
          continue;
        }
        const subject = op.subject?.trim();
        await store.remember({
          kind: op.kind?.trim() || DEFAULT_MEMORY_KIND,
          content,
          ...(subject ? { subject } : {}),
        });
        applied += 1;
      } else {
        // DELETE — forget everything under the subject (blank ⇒ nothing to target ⇒ skipped).
        const subject = op.subject?.trim();
        if (!subject) {
          skipped += 1;
          continue;
        }
        await store.forgetBySubject(subject);
        applied += 1;
      }
    } catch {
      skipped += 1; // fail-soft: one bad op never blocks the rest
    }
  }

  return { applied, skipped };
}
