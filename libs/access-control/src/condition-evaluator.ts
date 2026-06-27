import type { AccessShape } from '@aegis/shared-types';

/** Resolve a dotted attribute path (e.g. 'resource.amount', 'principal.userId') from the request. */
function resolveAttr(path: string, req: AccessShape.AccessRequest): unknown {
  const [root, ...rest] = path.split('.');
  let base: unknown;
  switch (root) {
    case 'principal':
      base = req.principal;
      break;
    case 'resource':
      base = req.resource;
      break;
    case 'environment':
      base = req.environment;
      break;
    case 'action':
      return req.action;
    default:
      return undefined;
  }
  for (const key of rest) {
    if (base == null) return undefined;
    // also look inside an `attributes` bag transparently
    const obj = base as Record<string, unknown>;
    base = key in obj ? obj[key] : (obj['attributes'] as Record<string, unknown> | undefined)?.[key];
  }
  return base;
}

function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

/** Evaluate one ABAC condition against the request. */
export function evalCondition(cond: AccessShape.PolicyCondition, req: AccessShape.AccessRequest): boolean {
  const left = resolveAttr(cond.attribute, req);
  const { operator, value } = cond;
  switch (operator) {
    case 'eq':
      return left === value;
    case 'neq':
      return left !== value;
    case 'lt':
      return asNumber(left) < asNumber(value);
    case 'lte':
      return asNumber(left) <= asNumber(value);
    case 'gt':
      return asNumber(left) > asNumber(value);
    case 'gte':
      return asNumber(left) >= asNumber(value);
    case 'in':
      return Array.isArray(value) && value.includes(left);
    case 'contains':
      return Array.isArray(left) ? left.includes(value) : typeof left === 'string' && left.includes(String(value));
    case 'owner':
      return req.resource?.ownerId != null && req.resource.ownerId === req.principal.userId;
    case 'manager_of': {
      const managed = (req.principal.attributes?.['managerOf'] as string[] | undefined) ?? [];
      return req.resource?.ownerId != null && managed.includes(req.resource.ownerId);
    }
    case 'tenant_match':
      return req.resource?.tenantId != null && req.resource.tenantId === req.principal.tenantId;
    default:
      return false;
  }
}

/** All conditions must pass (AND semantics). No conditions => vacuously true. */
export function conditionsMatch(
  conditions: AccessShape.PolicyCondition[] | undefined,
  req: AccessShape.AccessRequest,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((c) => evalCondition(c, req));
}
