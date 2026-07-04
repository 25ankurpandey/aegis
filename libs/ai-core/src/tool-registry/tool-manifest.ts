import type { AegisTool } from './types';

/**
 * The AI-Native Module Contract, in code. A per-service manifest lets a module author replace the
 * generated "METHOD path" placeholder with an intent-shaped description, and optionally declare a
 * `riskTier` (1 = benign … 4 = irreversible/material) and `tags` for the tool a model sees. The
 * manifest is keyed by the route key `${METHOD} ${path}` so it maps 1:1 onto guarded routes without
 * touching route code. Pure data + pure functions — no deps, no side effects.
 */
export interface ToolManifestEntry {
  /** Intent-shaped description shown to the model, e.g. "Create an expense". */
  description?: string;
  /** Governance risk tier: 1 (benign) … 4 (irreversible/material). */
  riskTier?: 1 | 2 | 3 | 4;
  /** Free-form classification tags, e.g. `["expense", "write"]`. */
  tags?: string[];
}

/** Per-service manifest keyed by the route key `${METHOD} ${path}` (e.g. `"POST /expense/v1/expenses"`). */
export type ToolManifest = Record<string, ToolManifestEntry>;

/** The manifest lookup key for a route: uppercased method + a single space + the raw express path. */
export function toolKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

/** Verb mapping for the deterministic default-description improver. */
const VERB_BY_METHOD: Record<string, string> = {
  GET: 'Get',
  POST: 'Create',
  PUT: 'Update',
  PATCH: 'Update',
  DELETE: 'Delete',
};

/**
 * Deterministic default-description improver: turns a method + express path into a short imperative
 * phrase, a better default than the raw "METHOD path". Examples:
 *   POST   /expense/v1/expenses      -> "Create an expense"
 *   GET    /expense/v1/expenses/:id  -> "Get an expense by id"
 *   DELETE /expense/v1/expenses/:id  -> "Delete an expense by id"
 * The noun is the last NON-param path segment, humanized and singularized (best-effort); a trailing
 * `:param` segment becomes a "by <param>" suffix.
 */
export function improveDescription(method: string, path: string): string {
  const verb = VERB_BY_METHOD[method.toUpperCase()] ?? method.toUpperCase();

  const segments = path.split('/').filter((s) => s.length > 0);
  const nonParamSegments = segments.filter((s) => !s.startsWith(':'));

  const lastNoun = nonParamSegments[nonParamSegments.length - 1];
  if (!lastNoun) {
    // No noun to describe — fall back to the raw form so the description is never empty.
    return `${verb} ${path}`.trim();
  }

  const noun = humanizeNoun(lastNoun);
  const article = startsWithVowel(noun) ? 'an' : 'a';

  const trailingParam = segments[segments.length - 1];
  const suffix =
    trailingParam && trailingParam.startsWith(':')
      ? ` by ${humanizeParam(trailingParam.slice(1))}`
      : '';

  return `${verb} ${article} ${noun}${suffix}`;
}

/**
 * Return a NEW tool with `description`/`riskTier`/`tags` overridden from the manifest entry (if any).
 * Fields absent from the entry are left unchanged. Never mutates the input tool.
 */
export function applyToolManifest(tool: AegisTool, manifest?: ToolManifest): AegisTool {
  const entry = manifest?.[toolKey(tool.method, tool.path)];
  if (!entry) return { ...tool };
  const next: AegisTool = { ...tool };
  if (entry.description !== undefined) next.description = entry.description;
  if (entry.riskTier !== undefined) next.riskTier = entry.riskTier;
  if (entry.tags !== undefined) next.tags = entry.tags;
  return next;
}

/** Humanize the last path segment into a lower-case singular-ish noun (`expenses` -> `expense`). */
function humanizeNoun(segment: string): string {
  const words = splitWords(segment);
  const last = words[words.length - 1] ?? segment;
  const singular = singularize(last);
  words[words.length - 1] = singular;
  return words.join(' ').toLowerCase();
}

/** Humanize a param name for the "by <x>" suffix (`userId` -> `user id`). */
function humanizeParam(param: string): string {
  return splitWords(param).join(' ').toLowerCase();
}

/** Split camelCase / kebab / snake into words. */
function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter((w) => w.length > 0);
}

/** Best-effort English singularization for common plural route nouns. */
function singularize(word: string): string {
  if (/ies$/i.test(word) && word.length > 3) return word.slice(0, -3) + 'y';
  // True "-es" plurals where the base ends in a sibilant cluster (boxes, buses, batches, dishes).
  if (/(xes|zes|ches|shes|sses)$/i.test(word)) return word.slice(0, -2);
  if (/ss$/i.test(word)) return word; // "address" is not a plural
  if (/s$/i.test(word) && word.length > 1) return word.slice(0, -1);
  return word;
}

function startsWithVowel(word: string): boolean {
  return /^[aeiou]/i.test(word);
}
