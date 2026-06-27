import type { ModelStatic, Model, Sequelize } from 'sequelize';
import { getSequelize, createModelRegistry } from '@aegis/db';
import { defineTenant } from './tenant.model';
import { defineUser } from './user.model';
import { definePermission } from './permission.model';
import { defineRole } from './role.model';
import { defineRolePermission } from './role-permission.model';
import { defineUserRole } from './user-role.model';
import { defineTenantConfig } from './tenant-config.model';
import { defineTenantFeature } from './tenant-feature.model';
import { definePolicy } from './policy.model';
import { defineInvite } from './invite.model';
import { defineSession } from './session.model';
import { defineTeam } from './team.model';
import { defineTeamMember } from './team-member.model';
import { defineTag } from './tag.model';
import { defineTeamTag } from './team-tag.model';
import { defineRecordTag } from './record-tag.model';

type M = ModelStatic<Model>;

/** The set of identity models, registered on the shared connection (the service's DatabaseContext). */
export interface IdentityContext {
  Tenant: M;
  User: M;
  Permission: M;
  Role: M;
  RolePermission: M;
  UserRole: M;
  TenantConfig: M;
  TenantFeature: M;
  Policy: M;
  Invite: M;
  Session: M;
  Team: M;
  TeamMember: M;
  Tag: M;
  TeamTag: M;
  RecordTag: M;
  sequelize: Sequelize;
}

let ctx: IdentityContext | null = null;

/**
 * Defines every identity model on the shared `getSequelize()` connection (once), wires the
 * associations, and returns the assembled context. The return shape is unchanged from the previous
 * single-file `context.ts`, so all callers keep working (SPEC §11.1 — one `*.model.ts` per table +
 * a `database-context.ts` that imports + registers them).
 */
export function getIdentityContext(): IdentityContext {
  if (ctx) return ctx;
  const s = getSequelize();

  // Single registration path through the registry (W2-09).
  const registry = createModelRegistry(s);

  const Tenant = registry.register(defineTenant(s));
  const User = registry.register(defineUser(s));
  const Permission = registry.register(definePermission(s));
  const Role = registry.register(defineRole(s));
  const RolePermission = registry.register(defineRolePermission(s));
  const UserRole = registry.register(defineUserRole(s));
  const TenantConfig = registry.register(defineTenantConfig(s));
  const TenantFeature = registry.register(defineTenantFeature(s));
  const Policy = registry.register(definePolicy(s));
  const Invite = registry.register(defineInvite(s));
  const Session = registry.register(defineSession(s));
  const Team = registry.register(defineTeam(s));
  const TeamMember = registry.register(defineTeamMember(s));
  const Tag = registry.register(defineTag(s));
  const TeamTag = registry.register(defineTeamTag(s));
  const RecordTag = registry.register(defineRecordTag(s));

  Role.belongsToMany(Permission, {
    through: RolePermission,
    foreignKey: 'role_id',
    otherKey: 'permission_id',
    as: 'permissions',
  });
  User.hasMany(UserRole, { foreignKey: 'user_id', as: 'userRoles' });
  UserRole.belongsTo(Role, { foreignKey: 'role_id', as: 'role' });

  // Team / tag governance associations (Wave-6).
  Team.hasMany(TeamMember, { foreignKey: 'team_id', as: 'members' });
  TeamMember.belongsTo(Team, { foreignKey: 'team_id', as: 'team' });
  Team.belongsToMany(Tag, { through: TeamTag, foreignKey: 'team_id', otherKey: 'tag_id', as: 'tags' });
  Tag.belongsToMany(Team, { through: TeamTag, foreignKey: 'tag_id', otherKey: 'team_id', as: 'teams' });

  ctx = {
    Tenant,
    User,
    Permission,
    Role,
    RolePermission,
    UserRole,
    TenantConfig,
    TenantFeature,
    Policy,
    Invite,
    Session,
    Team,
    TeamMember,
    Tag,
    TeamTag,
    RecordTag,
    sequelize: s,
  };
  return ctx;
}
