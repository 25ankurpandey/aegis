import type {
  Scope,
  UserStatus,
  ApprovalRecordType,
  InviteStatus,
  SessionStatus,
  TenantStatus,
} from '@aegis/shared-enums';

/**
 * Domain contract for the user-management service (the reference IdP + PAP + tenant config).
 * Service-local DTOs, repository row shapes, service inputs, and the JWT claim shape all live here
 * (SPEC §11.2 — no domain types defined inside the service). Controllers and services import these
 * from `@aegis/shared-types`; nothing identity-domain-typed is declared locally.
 */
export namespace UserManagementShape {
  // ---- Persistence row shapes (what repositories return; `*.get({ plain: true })`) ----

  /** A row of the `users` table. */
  export interface UserRow {
    id: string;
    tenant_id: string;
    email: string;
    first_name?: string;
    last_name?: string;
    password_hash: string;
    status: UserStatus;
  }

  /** A row of the `tenants` table. */
  export interface TenantRow {
    id: string;
    name: string;
    slug: string;
    status: TenantStatus;
  }

  /** A row of the `roles` table (system roles have a null `tenant_id`). */
  export interface RoleRow {
    id: string;
    tenant_id: string | null;
    name: string;
    description?: string;
    is_system: boolean;
  }

  /** A row of the `permissions` table. */
  export interface PermissionRow {
    id: string;
    name: string;
    description?: string;
  }

  /** A row of the `tenant_config` table (arbitrary per-tenant JSON, keyed by name). */
  export interface TenantConfigRow {
    id: string;
    tenant_id: string;
    key: string;
    value: unknown;
  }

  /** A row of the `tenant_features` table (a per-tenant feature flag). */
  export interface TenantFeatureRow {
    id: string;
    tenant_id: string;
    flag: string;
    enabled: boolean;
  }

  /** A row of the tenant-owned ABAC `policies` table. */
  export interface PolicyRow {
    id: string;
    tenant_id: string;
    permission: string;
    effect: 'allow' | 'deny';
    rule: unknown;
    priority: number;
    is_active: boolean;
    created_by?: string | null;
    updated_by?: string | null;
  }

  /** A row of the `invites` table. */
  export interface InviteRow {
    id: string;
    tenant_id: string;
    email: string;
    token_hash: string;
    status: InviteStatus;
    role_id: string | null;
    scope: Scope;
    team_ids: string[];
    expires_at: Date | string;
    accepted_at?: Date | string | null;
    revoked_at?: Date | string | null;
    created_by?: string | null;
  }

  /** A row of the `sessions` table (one issued access token/session handle). */
  export interface SessionRow {
    id: string;
    tenant_id: string;
    user_id: string;
    jti: string;
    status: SessionStatus;
    expires_at: Date | string;
    revoked_at?: Date | string | null;
    created_at?: Date | string;
  }

  // ---- Wave-6 team / tag governance row shapes ----

  /** A row of the `teams` table (a per-tenant team a record can be assigned to). */
  export interface TeamRow {
    id: string;
    tenant_id: string;
    name: string;
    description?: string | null;
    is_active: boolean;
  }

  /** A row of the `team_members` table (a user's membership in a team). */
  export interface TeamMemberRow {
    id: string;
    tenant_id: string;
    team_id: string;
    user_id: string;
    role?: string | null;
  }

  /** A row of the `tags` table (a per-tenant classification label). */
  export interface TagRow {
    id: string;
    tenant_id: string;
    name: string;
    color?: string | null;
    is_active: boolean;
  }

  /** A row of the `team_tags` table (a team→tag mapping). */
  export interface TeamTagRow {
    id: string;
    tenant_id: string;
    team_id: string;
    tag_id: string;
  }

  /** A row of the `record_tags` polymorphic join (a tag attached to one finance record). */
  export interface RecordTagRow {
    id: string;
    tenant_id: string;
    record_type: ApprovalRecordType;
    record_id: string;
    tag_id: string;
    source?: string | null;
    added_by?: string | null;
  }

  // ---- Wave-6 team / tag governance write inputs ----

  /** Input to create a `teams` row. */
  export interface CreateTeamInput {
    tenant_id: string;
    name: string;
    description?: string;
    created_by?: string | null;
    updated_by?: string | null;
  }

  /** Input to update a `teams` row. */
  export interface UpdateTeamInput {
    name?: string;
    description?: string | null;
    is_active?: boolean;
    updated_by?: string | null;
  }

  /** Input to add a user to a team. */
  export interface AddTeamMemberInput {
    tenant_id: string;
    team_id: string;
    user_id: string;
    role?: string;
  }

  /** Input to create a `tags` row. */
  export interface CreateTagInput {
    tenant_id: string;
    name: string;
    color?: string;
    created_by?: string | null;
    updated_by?: string | null;
  }

  /** Input to update a `tags` row. */
  export interface UpdateTagInput {
    name?: string;
    color?: string | null;
    is_active?: boolean;
    updated_by?: string | null;
  }

  /** Request body for assigning an owner/assignee to a finance record. */
  export interface AssignRecordInput {
    assigneeId: string | null;
  }

  /** Input to attach a catalog tag to a finance record (the polymorphic join write). */
  export interface AttachRecordTagInput {
    tenant_id: string;
    record_type: ApprovalRecordType;
    record_id: string;
    tag_id: string;
    source?: string;
    added_by?: string;
  }

  // ---- Resolved-access projection ----

  /** A user's flattened role name(s), permission names, and row-level scope. */
  export interface UserAccess {
    roles: string[];
    permissions: string[];
    scope: string;
  }

  // ---- Repository write inputs ----

  /** Input to create a `users` row. */
  export interface CreateUserInput {
    tenant_id: string;
    email: string;
    password_hash: string;
    first_name?: string;
    last_name?: string;
  }

  /** Input to create a `roles` row (always a non-system, tenant-scoped role). */
  export interface CreateRoleInput {
    tenant_id: string;
    name: string;
    description?: string;
  }

  /** Input to assign (or re-assign) the single role a user holds in the current tenant. */
  export interface AssignRoleRow {
    tenant_id: string;
    user_id: string;
    role_id: string;
    scope: string;
  }

  /** Input to upsert a `tenant_config` row. */
  export interface SetConfigRow {
    tenant_id: string;
    key: string;
    value: unknown;
  }

  /** Input to upsert a `tenant_features` row. */
  export interface SetFeatureRow {
    tenant_id: string;
    flag: string;
    enabled: boolean;
  }

  /** Input to create a `policies` row. */
  export interface CreatePolicyRow {
    tenant_id: string;
    permission: string;
    effect: 'allow' | 'deny';
    rule: unknown;
    priority: number;
    is_active: boolean;
    created_by?: string | null;
    updated_by?: string | null;
  }

  /** Patch for a `policies` row. */
  export interface UpdatePolicyRow {
    permission?: string;
    effect?: 'allow' | 'deny';
    rule?: unknown;
    priority?: number;
    is_active?: boolean;
    updated_by?: string | null;
  }

  /** Input to create an `invites` row. */
  export interface CreateInviteRow {
    tenant_id: string;
    email: string;
    token_hash: string;
    status: InviteStatus;
    role_id?: string | null;
    scope: Scope;
    team_ids: string[];
    expires_at: Date;
    created_by?: string | null;
  }

  /** Input to create a `sessions` row. */
  export interface CreateSessionRow {
    tenant_id: string;
    user_id: string;
    jti: string;
    status: SessionStatus;
    expires_at: Date;
  }

  // ---- Service inputs (the public method args) ----

  /** Args to `AuthService.register`. */
  export interface RegisterInput {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }

  /** Args to `AuthService.login`. */
  export interface LoginInput {
    email: string;
    password: string;
  }

  /** Args to `PapService.createRole`. */
  export interface CreateRolePapInput {
    name: string;
    description?: string;
    permissions: string[];
  }

  /** Args to `PapService.assignRole`. */
  export interface AssignRolePapInput {
    userId: string;
    roleId: string;
    scope?: Scope;
  }

  /** Args to `TenantConfigService.setConfig`. */
  export interface SetConfigInput {
    key: string;
    value: unknown;
  }

  /** Args to `TenantConfigService.setFlag`. */
  export interface SetFlagInput {
    flag: string;
    enabled: boolean;
  }

  /** Args to `PolicyService.create`. */
  export interface CreatePolicyInput {
    permission: string;
    effect: 'allow' | 'deny';
    rule?: unknown;
    priority?: number;
    isActive?: boolean;
  }

  /** Args to `PolicyService.update`. */
  export interface UpdatePolicyInput {
    permission?: string;
    effect?: 'allow' | 'deny';
    rule?: unknown;
    priority?: number;
    isActive?: boolean;
  }

  /** Args to `InviteService.create`. */
  export interface CreateInviteInput {
    email: string;
    roleId?: string;
    scope?: Scope;
    teamIds?: string[];
    expiresAt?: string;
  }

  // ---- Service result DTOs (the explicit response shapes) ----

  /** Result of `AuthService.register`. */
  export interface RegisterResult {
    id: string;
    email: string;
  }

  /** Result of `AuthService.login` — the issued JWT plus a minimal user projection. */
  export interface LoginResult {
    token: string;
    expiresIn: number;
    sessionId: string;
    user: { id: string; email: string; roles: string[] };
  }

  /** Result of `AuthService.me` — the caller's own identity + resolved access. */
  export interface MeResult {
    id: string;
    email: string;
    roles: string[];
    permissions: string[];
    scope: string;
  }

  /** Result of `PapService.assignRole`. */
  export interface AssignRoleResult {
    assigned: true;
  }

  /** Tenant DTO. */
  export interface TenantDto {
    id: string;
    name: string;
    slug: string;
    status: string;
  }

  /** User admin DTO. */
  export interface UserDto {
    id: string;
    email: string;
    firstName?: string;
    lastName?: string;
    status: string;
  }

  /** ABAC policy DTO. */
  export interface PolicyDto {
    id: string;
    permission: string;
    effect: 'allow' | 'deny';
    rule: unknown;
    priority: number;
    isActive: boolean;
  }

  /** Invite DTO. The raw token is only present on create. */
  export interface InviteDto {
    id: string;
    email: string;
    status: string;
    roleId: string | null;
    scope: string;
    teamIds: string[];
    expiresAt: string;
    token?: string;
  }

  /** Session DTO. */
  export interface SessionDto {
    id: string;
    userId: string;
    jti: string;
    status: string;
    expiresAt: string;
    revokedAt: string | null;
  }

  // ---- Internal service-to-service recipient directory DTOs ----

  /** Minimal contact projection resolved by internal notification fan-out. */
  export interface UserContactDto {
    userId: string;
    email?: string;
    phone?: string;
  }

  /** Internal audience lookup query used by notification's recipient resolver. */
  export interface RecipientDirectoryQuery {
    role?: string;
    groupId?: string;
    tenantAdmins?: boolean;
  }

  // ---- Token shape ----

  /** The claim set Aegis signs into the access JWT (consumed by the PEP's `authenticate`). */
  export interface JwtClaims {
    sub: string;
    tenant_id: string;
    roles: string[];
    permissions: string[];
    scope: string;
    aud: string;
  }
}
