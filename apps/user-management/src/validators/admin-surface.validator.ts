import Joi from 'joi';
import { Scope } from '@aegis/shared-enums';
// PAP write-time hardening (ABAC generalization §3 Q2, §5 Phase 0): the write path runs the SAME
// validation the load-time mapper applies, so a row that passes the PAP can never later fail the
// load (which is all-or-nothing — one bad persisted row would block the whole action, §3 Q1/Q8).
import {
  parseRuleEnvelope,
  policyActionOf,
  validatePolicyWrite,
} from '@aegis/access-control';

const email = Joi.string().email({ tlds: { allow: false } });

export const idParamSchema = Joi.object({
  id: Joi.string().uuid().required(),
});

/** `permission` must be a real `Permission` enum value or `'*'` (wildcard is deny-only — the
 * cross-field ban lives in the object-level check + `PolicyService`). The old `.min(3)` accepted
 * any free string, letting unmappable rows persist (§3 Q2). */
const policyPermission = Joi.string().custom((value: string, helpers) => {
  if (policyActionOf(value) === undefined) {
    return helpers.message({ custom: `permission must be a known Permission value or '*'` });
  }
  return value;
}, 'known Permission or wildcard');

/** The v1 rule envelope: `{conditions}` only — `scope` and unknown keys rejected, operators
 * whitelisted, `$attr` references syntax-checked. Same code path as the load-time mapper. */
const policyRule = Joi.object()
  .unknown(true) // keys are validated (and rejected) by the envelope parser, not silently stripped
  .custom((value: Record<string, unknown>, helpers) => {
    const parsed = parseRuleEnvelope(value);
    if (!parsed.ok) return helpers.message({ custom: `rule: ${parsed.reason}` });
    return value;
  }, 'v1 policy rule envelope');

export const createPolicySchema = Joi.object({
  permission: policyPermission.required(),
  effect: Joi.string().valid('allow', 'deny').required(),
  rule: policyRule.optional(),
  priority: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().optional(),
}).custom((value: { permission: string; effect: string; rule?: unknown }, helpers) => {
  // Full-write cross-field pass through the exact mapper-equivalent validator (wildcard-allow ban).
  const violations = validatePolicyWrite({ permission: value.permission, effect: value.effect, rule: value.rule ?? {} });
  if (violations.length > 0) return helpers.message({ custom: violations.join('; ') });
  return value;
}, 'mapper-equivalent policy write validation');

export const updatePolicySchema = Joi.object({
  permission: policyPermission.optional(),
  effect: Joi.string().valid('allow', 'deny').optional(),
  rule: policyRule.optional(),
  priority: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().optional(),
})
  .min(1)
  .custom((value: { permission?: string; effect?: string }, helpers) => {
    // Partial-patch guard; the authoritative merged-row check (patch over the persisted row) runs
    // in `PolicyService.update`, which is the only place the missing halves are known.
    if (value.permission === '*' && value.effect === 'allow') {
      return helpers.message({ custom: 'wildcard-action allow policies are banned (§3 Q8)' });
    }
    return value;
  }, 'wildcard-allow ban (partial)');

export const createInviteSchema = Joi.object({
  email: email.required(),
  roleId: Joi.string().uuid().optional(),
  scope: Joi.string()
    .valid(...Object.values(Scope))
    .optional(),
  teamIds: Joi.array().items(Joi.string().uuid()).optional(),
  expiresAt: Joi.string().isoDate().optional(),
});
