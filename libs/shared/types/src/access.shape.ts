import type { Permission, Scope } from '@aegis/shared-enums';

/**
 * The PDP/PEP contract (see docs/03-access-control-model.md). @aegis/access-control implements
 * `decide(request) => AccessDecision`; PEP guards consume these shapes.
 */
export namespace AccessShape {
  /** The authenticated subject, as known to the PDP. */
  export interface Principal {
    userId: string;
    tenantId: string;
    roles: string[];
    permissions?: Permission[];
    scope?: Scope;
    /** Subject attributes for ABAC (e.g. teamIds, managerOf, approvalLimit). */
    attributes?: Record<string, unknown>;
  }

  /** The thing being acted upon. */
  export interface ResourceRef {
    type: string;
    id?: string;
    tenantId?: string;
    ownerId?: string;
    teamId?: string;
    /** Resource attributes for ABAC (e.g. amount, status). */
    attributes?: Record<string, unknown>;
  }

  export interface AccessRequest {
    principal: Principal;
    action: Permission;
    resource?: ResourceRef;
    /** Environment attributes (time, ip, ...). */
    environment?: Record<string, unknown>;
  }

  /** Obligations the PEP must apply when allowing (e.g. mask sensitive columns). */
  export interface Obligation {
    type: 'mask_columns' | 'filter_rows';
    columns?: string[];
    rowFilter?: string;
  }

  export interface AccessDecision {
    allow: boolean;
    reason: string;
    obligations?: Obligation[];
  }

  /** A stored ABAC condition. */
  export interface PolicyCondition {
    attribute: string; // dotted path, e.g. 'resource.amount'
    operator: string; // eq | lt | lte | gt | gte | in | contains | owner | manager_of
    value?: unknown;
  }

  /** A persisted policy rule (dynamic, editable via the PAP). */
  export interface PolicyRule {
    id: string;
    tenantId?: string;
    effect: 'allow' | 'deny';
    action: Permission | '*';
    conditions?: PolicyCondition[];
    scope?: Scope;
  }
}
