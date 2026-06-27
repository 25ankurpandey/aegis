/** Identity / membership enums (user-management). See docs/services/user-management.md. */
export enum MembershipClaim {
  Owner = 'owner',
  Member = 'member',
}

export enum UserStatus {
  Active = 'active',
  Invited = 'invited',
  Disabled = 'disabled',
}

export enum InviteStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Revoked = 'revoked',
  Expired = 'expired',
}

export enum SessionStatus {
  Active = 'active',
  Revoked = 'revoked',
  Expired = 'expired',
}

/** Tenant lifecycle (provisioning → active → suspended → cancelled). Pins `tenants.status`. */
export enum TenantStatus {
  Active = 'active',
  Suspended = 'suspended',
  Cancelled = 'cancelled',
  Provisioning = 'provisioning',
}
