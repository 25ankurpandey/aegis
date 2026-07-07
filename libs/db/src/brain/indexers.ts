import type { AppBrainService } from './app-brain.service';
import type { RememberInput } from './types';

/**
 * App-brain INDEXERS — the feeds that bring the brain online. Each indexer flattens a platform
 * artifact (a tool definition, an audit finding, ...) into a {@link RememberInput} and stores it
 * through {@link AppBrainService.remember}, so agents can `recall` over the platform's own surface
 * area ("which tool creates an expense?", "what did the last audit flag about X?").
 *
 * Param types are STRUCTURAL on purpose (no `@aegis/ai-core` import): any object with the right
 * shape indexes — the libs/db layer stays dependency-free of the AI layer. The pure
 * `build*MemoryInput` functions are exported separately so the content composition is unit-testable
 * without a DB.
 */

/** Structural shape of an indexable tool definition (mirrors the ai-core tool registry entries). */
export interface IndexableTool {
  name: string;
  description: string;
  method?: string;
  path?: string;
  requiredPermissions?: readonly string[];
}

/** Structural shape of an indexable audit proposal (mirrors the ai-core auditor's proposals). */
export interface IndexableAuditProposal {
  checkId: string;
  status: string;
  blast: string;
  finding: {
    subjectRef: string;
    summary: string;
    expected: unknown;
    observed: unknown;
    recommendation: string;
  };
}

/** JSON-render an unknown value for memory content (undefined stringifies to "undefined", not ''). */
function asJson(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/**
 * Pure content composition for one tool memory: kind "tool", upsert-keyed by ref = the tool name,
 * superseded by subject = "tool:<name>" (re-indexing replaces the previous description instead of
 * accumulating), content = description + route + required permissions so lexical recall matches on
 * any of them.
 */
export function buildToolMemoryInput(tool: IndexableTool): RememberInput {
  const permissions = tool.requiredPermissions ?? [];
  return {
    kind: 'tool',
    ref: tool.name,
    subject: `tool:${tool.name}`,
    title: tool.name,
    content: `${tool.description} [${tool.method ?? ''} ${tool.path ?? ''}] requires: ${permissions.join(',')}`,
  };
}

/**
 * Pure content composition for one audit-finding memory: kind "audit_finding", upsert-keyed by
 * ref = "<checkId>:<subjectRef>", superseded by subject = "audit:<subjectRef>" (a NEW finding about
 * the same subject replaces the stale one), content = summary + expected/observed + recommendation,
 * metadata = { status, blast }.
 */
export function buildAuditMemoryInput(proposal: IndexableAuditProposal): RememberInput {
  const { checkId, status, blast, finding } = proposal;
  return {
    kind: 'audit_finding',
    ref: `${checkId}:${finding.subjectRef}`,
    subject: `audit:${finding.subjectRef}`,
    title: `${checkId} — ${finding.subjectRef}`,
    content:
      `${finding.summary} ` +
      `expected: ${asJson(finding.expected)} observed: ${asJson(finding.observed)} ` +
      `recommendation: ${finding.recommendation}`,
    metadata: { status, blast },
  };
}

/**
 * Index a batch of tool definitions into the app-brain (one memory per tool, sequential so the
 * per-tool supersede+upsert transactions never race each other). Returns the number indexed.
 */
export async function indexTools(
  service: AppBrainService,
  tools: ReadonlyArray<IndexableTool>,
): Promise<number> {
  let count = 0;
  for (const tool of tools) {
    await service.remember(buildToolMemoryInput(tool));
    count += 1;
  }
  return count;
}

/** Index one audit proposal's finding into the app-brain (superseding prior findings on its subject). */
export async function indexAuditProposal(
  service: AppBrainService,
  proposal: IndexableAuditProposal,
): Promise<void> {
  await service.remember(buildAuditMemoryInput(proposal));
}
