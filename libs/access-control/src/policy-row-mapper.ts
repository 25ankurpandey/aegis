import { Permission } from '@aegis/shared-enums';
import type { AccessShape } from '@aegis/shared-types';

/**
 * Pure `PolicyRow -> AccessShape.PolicyRule | MappingError` mapper (ABAC generalization Phase 0 —
 * docs/strategy/abac-generalization.md §3 Q1/Q8, §5 Phase 0).
 *
 * Persisted `policies` rows (migration 0028) are administered by the PAP but never consumed by
 * enforcement today. This module is the bridge's first, dormant half: it validates the persisted
 * `rule` JSONB envelope and converts rows into the `AccessShape.PolicyRule[]` the PDP evaluates.
 * No loader is wired here (that is Phase 1) — shipping this changes no runtime behavior.
 *
 * Contract highlights (all from the spec):
 *  - **v1 envelope is `{conditions}` only.** A `scope` key is REJECTED: `PolicyRule.scope` is consumed
 *    by nothing in the runtime (pdp.ts never reads it; checkRowScope reads only `principal.scope`),
 *    so accepting it would ship a write-accepted, never-read field (§3 Q1, §7). Any other unknown
 *    envelope key is rejected under the same discipline.
 *  - **Reject-on-parse-failure — never coerce a malformed rule into `conditions: []`** (empty
 *    conditions are vacuously true, condition-evaluator.ts:70-76). An explicit `{}` / `{conditions: []}`
 *    is a legitimate "unconditional" rule (the DB default `rule` is `{}`); an unparseable blob is a
 *    `MappingError`. Unconditional DENY rows additionally surface a warning (§3 Q1).
 *  - **All-or-nothing (§3 Q8, §6):** any `MappingError` across the fetched set fails the WHOLE load —
 *    `mapPolicyRows` returns `rules: []` alongside the errors, never a partial set. A silently dropped
 *    deny fails open directly; a silently dropped allow fails open by emptying the PDP's allow-gate
 *    (pdp.ts:47-50, 93-97). Callers MUST treat `errors.length > 0` as a failed load (block + alert).
 *  - **Wildcard-action ALLOW rows are banned** (`decide()` ignores `'*'` allows while `evaluateAbac()`
 *    honors them — pdp.ts:47 vs :93); a legacy one at load time is a `MappingError`, never a silent
 *    skip. Wildcard DENY is consistent on both paths and fine (§3 Q8).
 *  - **`$attr` is validated-but-reserved (§3 Q3):** a condition `value` may be a literal or an
 *    attribute reference (`{"$attr": "principal.approvalLimit"}` or
 *    `{"$attr": {"path": ..., "missing": "skip"|"fail"}}`). Phase 0 ships no interpolation — the
 *    marker is kept RAW on the mapped rule — but malformed references are refused already.
 *  - **`is_active !== true` rows are filtered** (the one legitimate row drop — an administered state,
 *    not a parse failure; the repository's `list()` does not filter). Inactive rows are dropped
 *    BEFORE validation so a malformed legacy row can be remediated by deactivation.
 *  - **Deterministic ordering:** `priority ASC, id ASC` — determinism only (stable deny-reason
 *    selection); the PDP consumes no priority and deny-overrides is order-independent (§3 Q8).
 */

/** Structural shape of a persisted `policies` row (PAP storage, migration 0028). Structurally
 * compatible with `UserManagementShape.PolicyRow` without importing user-management types. */
export interface PolicyRow {
  id: string;
  tenant_id: string;
  /** Free string in the DB — validated here against the `Permission` enum (or `'*'`). */
  permission: string;
  /** `'allow' | 'deny'` per the DB CHECK constraint — re-validated defensively for raw reads. */
  effect: string;
  /** The persisted JSONB rule envelope (untyped end-to-end today). */
  rule: unknown;
  priority: number;
  is_active: boolean;
}

/** One unmappable/policy-violating row. ANY error fails the whole load (all-or-nothing, §3 Q8). */
export interface MappingError {
  rowId: string;
  /** The raw persisted permission string (may be the unknown value that caused the error). */
  permission: string;
  reason: string;
}

/** Non-fatal advisory surfaced by the mapper (e.g. an unconditional deny row — §3 Q1). */
export interface MappingWarning {
  rowId: string;
  message: string;
}

export interface MapPolicyRowsResult {
  /** Mapped, active-only, `priority ASC, id ASC`-sorted rules — ALWAYS `[]` when `errors` is non-empty. */
  rules: AccessShape.PolicyRule[];
  /** Non-empty means the load FAILED (all-or-nothing): callers must block, not enforce partially. */
  errors: MappingError[];
  /** Advisories (unconditional deny rows). Never affects the load outcome. */
  warnings: MappingWarning[];
}

/** The 11 operators `evalCondition` implements (condition-evaluator.ts:39-66). Unknown => fail-closed
 * there, `MappingError` here — a persisted rule must never rely on the runtime's silent `false`. */
export const POLICY_CONDITION_OPERATORS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'contains',
  'owner',
  'manager_of',
  'tenant_match',
] as const;

const OPERATOR_SET = new Set<string>(POLICY_CONDITION_OPERATORS);

/** Operators whose `value` is ignored by the evaluator, hence not required (§3 Q1). */
const VALUELESS_OPERATORS = new Set<string>(['owner', 'tenant_match']);

/** Attribute-path roots `resolveAttr` understands (condition-evaluator.ts:4-29). */
const ATTRIBUTE_ROOTS = new Set<string>(['principal', 'resource', 'environment', 'action']);

const ATTR_REF_KEY = '$attr';
const ATTR_MISSING_MODES = new Set<string>(['skip', 'fail']);
const CONDITION_KEYS = new Set<string>(['attribute', 'operator', 'value']);

const PERMISSION_VALUES = new Set<string>(Object.values(Permission));

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A dotted path rooted at principal|resource|environment|action, with no empty segments. The bare
 * `action` root takes no sub-path (`resolveAttr` ignores anything after it, so a sub-path would be
 * administered-but-meaningless — refused per the never-ship-inert-fields discipline, §7). */
function isValidAttrPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) return false;
  const segments = path.split('.');
  if (segments.some((s) => s.length === 0)) return false;
  if (!ATTRIBUTE_ROOTS.has(segments[0])) return false;
  if (segments[0] === 'action' && segments.length > 1) return false;
  return true;
}

/** Validate a condition `value` that carries an `$attr` reference (§3 Q3 — validate-but-reserve).
 * Returns an error string, or undefined when valid OR when the value is not an `$attr` ref at all. */
function attrRefError(value: unknown): string | undefined {
  if (!isPlainObject(value) || !(ATTR_REF_KEY in value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    return `"$attr" reference must be the only key of its value object (got: ${keys.join(', ')})`;
  }
  const ref = value[ATTR_REF_KEY];
  if (typeof ref === 'string') {
    return isValidAttrPath(ref)
      ? undefined
      : `"$attr" path '${ref}' must be a dotted path rooted at principal|resource|environment|action`;
  }
  if (isPlainObject(ref)) {
    const extra = Object.keys(ref).filter((k) => k !== 'path' && k !== 'missing');
    if (extra.length > 0) return `"$attr" object allows only {path, missing} (got: ${extra.join(', ')})`;
    if (!isValidAttrPath(ref['path'])) {
      return '"$attr".path must be a dotted path rooted at principal|resource|environment|action';
    }
    if (ref['missing'] !== undefined && !ATTR_MISSING_MODES.has(ref['missing'] as string)) {
      return `"$attr".missing must be 'skip' or 'fail'`;
    }
    return undefined;
  }
  return '"$attr" must be a string path or a {path, missing} object';
}

function conditionError(cond: unknown, index: number): string | undefined {
  if (!isPlainObject(cond)) return `conditions[${index}] must be an object`;
  const extra = Object.keys(cond).filter((k) => !CONDITION_KEYS.has(k));
  if (extra.length > 0) {
    return `conditions[${index}] has unknown key(s): ${extra.join(', ')} (allowed: attribute, operator, value)`;
  }
  if (!isValidAttrPath(cond['attribute'])) {
    return `conditions[${index}].attribute must be a dotted path rooted at principal|resource|environment|action`;
  }
  const operator = cond['operator'];
  if (typeof operator !== 'string' || !OPERATOR_SET.has(operator)) {
    return `conditions[${index}].operator '${String(operator)}' is not a known operator (${POLICY_CONDITION_OPERATORS.join(', ')})`;
  }
  if (!VALUELESS_OPERATORS.has(operator) && cond['value'] === undefined) {
    return `conditions[${index}].value is required for operator '${operator}'`;
  }
  const refError = attrRefError(cond['value']);
  if (refError) return `conditions[${index}]: ${refError}`;
  return undefined;
}

/**
 * Parse + validate the persisted `rule` JSONB against the v1 envelope (§3 Q1): `{conditions}` only.
 * `{}` (the DB default) and an explicit `{"conditions": []}` both mean "unconditional" — a deliberate,
 * documented decode, never a coercion of a malformed blob. Shared verbatim by the PAP write-time
 * validators (§3 Q2) so a row that passes the PAP can never later fail the load.
 */
export function parseRuleEnvelope(
  rule: unknown,
): { ok: true; conditions: AccessShape.PolicyCondition[] } | { ok: false; reason: string } {
  if (!isPlainObject(rule)) return { ok: false, reason: 'rule must be a JSON object' };
  if ('scope' in rule) {
    return {
      ok: false,
      reason:
        "rule.scope is banned from the v1 envelope: PolicyRule.scope is consumed by nothing in the runtime (docs/strategy/abac-generalization.md §3 Q1)",
    };
  }
  const unknownKeys = Object.keys(rule).filter((k) => k !== 'conditions');
  if (unknownKeys.length > 0) {
    return { ok: false, reason: `rule has unknown key(s): ${unknownKeys.join(', ')} (v1 envelope is {conditions} only)` };
  }
  const conditions = rule['conditions'];
  if (conditions === undefined) return { ok: true, conditions: [] };
  if (!Array.isArray(conditions)) return { ok: false, reason: 'rule.conditions must be an array' };
  for (let i = 0; i < conditions.length; i += 1) {
    const err = conditionError(conditions[i], i);
    if (err) return { ok: false, reason: err };
  }
  return { ok: true, conditions: conditions as AccessShape.PolicyCondition[] };
}

/** Validate a persisted permission string: a known `Permission` value or `'*'`; undefined otherwise. */
export function policyActionOf(permission: string): Permission | '*' | undefined {
  if (permission === '*') return '*';
  return PERMISSION_VALUES.has(permission) ? (permission as Permission) : undefined;
}

/**
 * PAP write-time validation (§3 Q2) over a candidate `{permission, effect, rule}` write — the SAME
 * checks the mapper applies at load time, so PAP-accepted rows are mappable by construction.
 * Returns every violation (empty array = valid write).
 */
export function validatePolicyWrite(input: { permission: string; effect: string; rule?: unknown }): string[] {
  const violations: string[] = [];
  const action = policyActionOf(input.permission);
  if (action === undefined) {
    violations.push(`permission '${input.permission}' is not a known Permission (or '*')`);
  }
  if (input.effect !== 'allow' && input.effect !== 'deny') {
    violations.push(`effect '${input.effect}' must be 'allow' or 'deny'`);
  }
  if (action === '*' && input.effect === 'allow') {
    violations.push(
      "wildcard-action allow policies are banned (decide() ignores '*' allows while evaluateAbac() honors them — §3 Q8)",
    );
  }
  const envelope = parseRuleEnvelope(input.rule ?? {});
  if (!envelope.ok) violations.push(envelope.reason);
  return violations;
}

/** Per-row mapping result. `warning` is advisory (unconditional deny); it never fails the row. */
export type MapPolicyRowResult =
  | { ok: true; rule: AccessShape.PolicyRule; warning?: string }
  | { ok: false; error: MappingError };

/**
 * Map ONE row, ignoring `is_active` (callers filter; the audit script inspects inactive rows too).
 * Pure: no I/O, no clock, no logging.
 */
export function mapPolicyRow(row: PolicyRow): MapPolicyRowResult {
  const fail = (reason: string): MapPolicyRowResult => ({
    ok: false,
    error: { rowId: row.id, permission: row.permission, reason },
  });

  if (row.effect !== 'allow' && row.effect !== 'deny') {
    return fail(`effect '${row.effect}' must be 'allow' or 'deny'`);
  }
  const action = policyActionOf(row.permission);
  if (action === undefined) {
    return fail(`permission '${row.permission}' is not a known Permission (or '*')`);
  }
  if (action === '*' && row.effect === 'allow') {
    return fail(
      "wildcard-action allow policies are banned (decide() ignores '*' allows while evaluateAbac() honors them — §3 Q8)",
    );
  }
  const envelope = parseRuleEnvelope(row.rule);
  if (!envelope.ok) return fail(envelope.reason);

  const rule: AccessShape.PolicyRule = {
    id: row.id,
    tenantId: row.tenant_id,
    effect: row.effect,
    action,
    conditions: envelope.conditions,
  };
  const warning =
    row.effect === 'deny' && envelope.conditions.length === 0
      ? 'unconditional deny: empty conditions match every request for this action (§3 Q1)'
      : undefined;
  return warning === undefined ? { ok: true, rule } : { ok: true, rule, warning };
}

/** `priority ASC, id ASC` (code-unit id comparison — locale-independent determinism). */
function byPriorityThenId(a: PolicyRow, b: PolicyRow): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.id < b.id) return -1;
  return a.id > b.id ? 1 : 0;
}

/**
 * Map a fetched set of rows with ALL-OR-NOTHING semantics (§3 Q1/Q8, §6): inactive rows are filtered
 * (the one legitimate drop), the rest are validated and mapped in `priority ASC, id ASC` order, and if
 * ANY active row errors — either effect — the whole load fails: `rules` comes back EMPTY next to the
 * errors so even a caller that ignores `errors` can never enforce a partial set. Callers must treat
 * `errors.length > 0` as a failed load (block the request + alert), never as "fewer policies".
 */
export function mapPolicyRows(rows: PolicyRow[]): MapPolicyRowsResult {
  const active = rows.filter((r) => r.is_active === true).sort(byPriorityThenId);

  const rules: AccessShape.PolicyRule[] = [];
  const errors: MappingError[] = [];
  const warnings: MappingWarning[] = [];
  for (const row of active) {
    const result = mapPolicyRow(row);
    if (result.ok) {
      rules.push(result.rule);
      if (result.warning) warnings.push({ rowId: row.id, message: result.warning });
    } else {
      errors.push(result.error);
    }
  }
  if (errors.length > 0) return { rules: [], errors, warnings };
  return { rules, errors, warnings };
}
