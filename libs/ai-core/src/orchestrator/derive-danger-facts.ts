import type { AegisTool } from '../tool-registry/types';
import type { DangerFacts, VerbClass } from '../danger/types';

/**
 * DETERMINISTIC facts derivation for the danger gate (docs/strategy §3.1).
 *
 * The danger classifier is deterministic and must NEVER read model output. This helper computes the
 * `DangerFacts` for a chosen tool + validated args PURELY from the tool's static shape (HTTP method,
 * route path) and structural properties of the args (numeric amount, array/count sizes) — never from
 * anything the LLM "decided". It is the seam between "the agent reasons" and "the governed core acts":
 * the model may select WHICH permitted tool to run, but the facts that drive the ceremony are computed
 * server-side here, so the model can never talk the classifier down.
 *
 * NOTE (blast radius): the authoritative `count` is a pre-flight COUNT(*) run inside the live RLS tx
 * (see danger-gate.ts). This orchestrator seam has no tx, so it derives a BEST-EFFORT count from the
 * args (explicit `count`, or the length of an array arg / `ids`). The app re-derives and re-runs the
 * gate at execute time against the true count — a drift voids any challenge (§3.3, §6.3).
 */

/** Map an HTTP method to the danger verb class. Unknown/other methods fail toward `execute`. */
function verbClassForMethod(method: string): VerbClass {
  switch (method.toUpperCase()) {
    case 'GET':
    case 'HEAD':
      return 'read';
    case 'POST':
      return 'create';
    case 'PUT':
    case 'PATCH':
      return 'update';
    case 'DELETE':
      return 'delete';
    default:
      return 'execute';
  }
}

/**
 * The resource class is the last NON-PARAMETER path segment (e.g. `/expense/v1/expenses/:id` ⇒
 * `expenses`). Express params (`:id`) and their `{id}`-style equivalents are skipped so a per-row route
 * classifies by its collection, not by the id placeholder.
 */
function resourceClassForPath(path: string): string {
  const segments = path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith(':') && !(s.startsWith('{') && s.endsWith('}')));
  return segments.length > 0 ? segments[segments.length - 1] : 'resource';
}

/** Read a finite positive number from an arg, or undefined. */
function numericArg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Best-effort blast-radius count from the args: an explicit numeric `count`, else the length of the
 * first array-valued arg (preferring `ids`). Absent ⇒ undefined (the gate treats undefined as 1).
 */
function deriveCount(args: Record<string, unknown>): number | undefined {
  const explicit = numericArg(args.count);
  if (explicit !== undefined) return explicit;
  if (Array.isArray(args.ids)) return args.ids.length;
  for (const value of Object.values(args)) {
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

/**
 * Derive the DETERMINISTIC {@link DangerFacts} for a chosen tool + validated args. Pure: the same
 * tool + args always yield the same facts. `dataSensitivity`/`regulatory` are left undefined here (not
 * safely inferable from method + path alone); the tool manifest / app supplies them where known.
 */
export function deriveDangerFacts(
  tool: AegisTool,
  args: Record<string, unknown>,
): DangerFacts {
  const verbClass = verbClassForMethod(tool.method);
  const facts: DangerFacts = {
    verbClass,
    resourceClass: resourceClassForPath(tool.path),
    irreversible: verbClass === 'delete',
  };

  const count = deriveCount(args);
  if (count !== undefined) facts.count = count;

  const amountMinor = numericArg(args.amountMinor) ?? numericArg(args.amount);
  if (amountMinor !== undefined) facts.amountMinor = amountMinor;

  // Prefer the tool's EXPLICIT risk tier when the module manifest declared one — a declared tier is
  // authoritative over the method-based heuristics above (the classifier still floors it by blast facts).
  if (tool.riskTier !== undefined) facts.riskTier = tool.riskTier;

  return facts;
}
