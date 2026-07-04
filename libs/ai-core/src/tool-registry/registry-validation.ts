import type { AegisTool, ToolRegistry } from './types';

/**
 * @aegis/ai-core / tool-registry — the CI DRIFT GATE for the generated tool registry.
 *
 * This is Aegis's mirror of Wayfinder's `CapabilityManifest.Validate()`: run it in CI (and at service
 * boot) so a new module can NOT ship a tool that is ungoverned, undescribed, or — for a mutation —
 * missing a risk tier. A tool that reaches an agent must carry a real (non-placeholder) description, an
 * authz binding (non-empty `permissions`), and an input schema; writes should additionally declare how
 * dangerous they are so the danger gate has something to classify.
 *
 * The check is DETERMINISTIC, PURE and OFFLINE: the same registry (and options) always yields a
 * deep-equal result, and issues come back in a stable order (input tool order, then a fixed per-tool
 * check order). Nothing here calls the network, reads a clock, or mutates its input.
 */

/** A single problem found with one tool in the registry. */
export interface RegistryIssue {
  /** The offending tool's `name` (or the duplicated name, for the duplicate-name check). */
  toolName: string;
  /** `error` fails the gate; `warn` is advisory (surfaced but does not fail CI on its own). */
  severity: 'error' | 'warn';
  /** Stable machine-readable code, e.g. `placeholder_description`, `no_permissions`. */
  code: string;
  /** Human-readable explanation of what is wrong and why it matters. */
  message: string;
}

/** The outcome of validating a whole registry. `ok` iff there are zero errors (warnings are allowed). */
export interface RegistryValidationResult {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: RegistryIssue[];
}

/** Options that tighten the gate (a tenant/module may opt into stricter-than-floor checks). */
export interface ValidateRegistryOptions {
  /** When true, a mutating tool with no `riskTier` is an ERROR rather than a WARN. */
  requireRiskTier?: boolean;
}

/** HTTP methods that mutate state — these are the tools the danger gate must be able to classify. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The old "METHOD /path" description form the generator emitted before manifests supplied real prose. */
const PLACEHOLDER_DESCRIPTION = /^(GET|POST|PUT|PATCH|DELETE)\s+\//;

/** Heuristic: a tool whose method or name signals a destructive/irreversible action. */
function looksIrreversible(tool: AegisTool): boolean {
  if (tool.method.toUpperCase() === 'DELETE') return true;
  return /delete|remove|destroy|purge|revoke|void/i.test(tool.name);
}

/**
 * Validate a generated tool registry against the governance floors. Pure and deterministic — see the
 * file doc-comment. Errors fail the gate; warnings are advisory. Checks (in fixed order per tool):
 *
 *   ERROR  empty/placeholder description (placeholder = the old `METHOD /path` form)
 *   ERROR  empty `permissions` (the tool is not authz-bound)
 *   ERROR  missing `inputSchema`
 *   ERROR  duplicate tool `name` (reported once per extra occurrence)
 *   WARN   mutating tool (POST/PUT/PATCH/DELETE) with no `riskTier`
 *          (upgraded to ERROR when `opts.requireRiskTier`)
 *   WARN   delete/irreversible-looking tool with `riskTier` < 3
 */
export function validateToolRegistry(
  registry: ToolRegistry,
  opts?: ValidateRegistryOptions,
): RegistryValidationResult {
  const issues: RegistryIssue[] = [];
  const requireRiskTier = opts?.requireRiskTier === true;
  const seen = new Set<string>();

  for (const tool of registry.tools) {
    const description = tool.description ?? '';
    if (description.trim() === '' || PLACEHOLDER_DESCRIPTION.test(description.trim())) {
      issues.push({
        toolName: tool.name,
        severity: 'error',
        code: 'placeholder_description',
        message:
          'Tool has an empty or placeholder ("METHOD /path") description — supply a real description in the module manifest before shipping.',
      });
    }

    if (!Array.isArray(tool.permissions) || tool.permissions.length === 0) {
      issues.push({
        toolName: tool.name,
        severity: 'error',
        code: 'no_permissions',
        message: 'Tool has no permissions — it is not authz-bound. Only guarded routes may become tools.',
      });
    }

    if (tool.inputSchema === undefined || tool.inputSchema === null) {
      issues.push({
        toolName: tool.name,
        severity: 'error',
        code: 'missing_input_schema',
        message: 'Tool has no inputSchema — an agent cannot be told how to call it safely.',
      });
    }

    if (seen.has(tool.name)) {
      issues.push({
        toolName: tool.name,
        severity: 'error',
        code: 'duplicate_name',
        message: `Duplicate tool name "${tool.name}" — tool names must be unique within a registry.`,
      });
    } else {
      seen.add(tool.name);
    }

    const isMutating = MUTATING_METHODS.has(tool.method.toUpperCase());
    if (isMutating && tool.riskTier === undefined) {
      issues.push({
        toolName: tool.name,
        severity: requireRiskTier ? 'error' : 'warn',
        code: 'mutating_tool_missing_risk_tier',
        message:
          'Mutating tool has no riskTier — the danger gate cannot classify it. Declare a riskTier in the module manifest.',
      });
    }

    if (looksIrreversible(tool) && tool.riskTier !== undefined && tool.riskTier < 3) {
      issues.push({
        toolName: tool.name,
        severity: 'warn',
        code: 'irreversible_tool_low_risk_tier',
        message:
          'Delete/irreversible-looking tool has riskTier < 3 — irreversible actions should carry a higher risk tier.',
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;
  return { ok: errors === 0, errors, warnings, issues };
}
