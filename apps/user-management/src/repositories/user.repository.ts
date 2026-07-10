import { QueryTypes, type Transaction } from 'sequelize';
import { SystemRole, UserStatus } from '@aegis/shared-enums';
import { UserManagementShape } from '@aegis/shared-types';
import { getSequelize } from '@aegis/db';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for the user aggregate (the `users` table + the user's resolved access). Every method
 * takes the ambient RLS-scoped `Transaction` (the SERVICE opens it via `withTenantTransaction`), so a
 * tenant only ever sees its own rows.
 */
@provideSingleton(UserRepository)
export class UserRepository {
  async findByEmail(email: string, t: Transaction): Promise<UserManagementShape.UserRow | null> {
    const { User } = getIdentityContext();
    const row = await User.findOne({ where: { email }, transaction: t });
    return row ? (row.get({ plain: true }) as UserManagementShape.UserRow) : null;
  }

  async findById(id: string, t: Transaction): Promise<UserManagementShape.UserRow | null> {
    const { User } = getIdentityContext();
    const row = await User.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as UserManagementShape.UserRow) : null;
  }

  async list(t: Transaction): Promise<UserManagementShape.UserRow[]> {
    const { User } = getIdentityContext();
    const rows = await User.findAll({ order: [['created_at', 'DESC']], transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.UserRow);
  }

  async getContactById(
    id: string,
    t: Transaction,
  ): Promise<UserManagementShape.UserContactDto | null> {
    const { User } = getIdentityContext();
    const row = await User.findOne({ where: { id, status: UserStatus.Active }, transaction: t });
    return row ? this.toContact(row.get({ plain: true }) as UserManagementShape.UserRow) : null;
  }

  async listContactsByUserIds(
    ids: string[],
    t: Transaction,
  ): Promise<UserManagementShape.UserContactDto[]> {
    if (ids.length === 0) return [];
    const { User } = getIdentityContext();
    const rows = await User.findAll({
      where: { id: [...new Set(ids)], status: UserStatus.Active },
      transaction: t,
    });
    return rows.map((r) => this.toContact(r.get({ plain: true }) as UserManagementShape.UserRow));
  }

  async listContactsByRole(
    roleName: string,
    t: Transaction,
  ): Promise<UserManagementShape.UserContactDto[]> {
    const { Role, UserRole } = getIdentityContext();
    const roles = await Role.findAll({ where: { name: roleName }, transaction: t });
    const roleIds = roles.map((r) => (r.get({ plain: true }) as UserManagementShape.RoleRow).id);
    if (roleIds.length === 0) return [];

    const assignments = await UserRole.findAll({ where: { role_id: roleIds }, transaction: t });
    return this.listContactsByUserIds(
      assignments.map((r) => (r.get({ plain: true }) as { user_id: string }).user_id),
      t,
    );
  }

  async listTenantAdminContacts(t: Transaction): Promise<UserManagementShape.UserContactDto[]> {
    const adminContacts = await this.listContactsByRole(SystemRole.Admin, t);
    const ownerContacts = await this.listContactsByRole(SystemRole.Owner, t);
    return this.uniqueContacts([...adminContacts, ...ownerContacts]);
  }

  async listContactsByTeam(
    teamId: string,
    t: Transaction,
  ): Promise<UserManagementShape.UserContactDto[]> {
    const { TeamMember } = getIdentityContext();
    const rows = await TeamMember.findAll({ where: { team_id: teamId }, transaction: t });
    return this.listContactsByUserIds(
      rows.map((r) => (r.get({ plain: true }) as UserManagementShape.TeamMemberRow).user_id),
      t,
    );
  }

  async create(data: UserManagementShape.CreateUserInput, t: Transaction): Promise<UserManagementShape.UserRow> {
    const { User } = getIdentityContext();
    const row = await User.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.UserRow;
  }

  /** Resolve the user's role name(s), flattened permission names, and row-level scope. */
  async getAccess(userId: string, t: Transaction): Promise<UserManagementShape.UserAccess> {
    // PIP attributes (teamIds + managerOf + approvalLimit) are loaded regardless of role assignment
    // so that a scoped user still gets them; they ride into the signed token at login (see
    // AuthService.login).
    const { teamIds, managerOf, approvalLimit } = await this.loadPipAttributes(userId, t);

    const { UserRole, Role, RolePermission, Permission } = getIdentityContext();
    const userRoles = await UserRole.findAll({ where: { user_id: userId }, transaction: t });
    if (userRoles.length === 0) {
      return { roles: [], permissions: [], scope: 'own_only', teamIds, managerOf, approvalLimit };
    }

    const ur = userRoles[0].get({ plain: true }) as { role_id: string; scope: string };
    const role = await Role.findByPk(ur.role_id, { transaction: t });
    const roleName = role ? (role.get({ plain: true }) as { name: string }).name : undefined;

    const rps = await RolePermission.findAll({ where: { role_id: ur.role_id }, transaction: t });
    const permIds = rps.map((r) => (r.get({ plain: true }) as { permission_id: string }).permission_id);
    const perms = permIds.length
      ? await Permission.findAll({ where: { id: permIds }, transaction: t })
      : [];
    const permNames = perms.map((p) => (p.get({ plain: true }) as { name: string }).name);

    return { roles: roleName ? [roleName] : [], permissions: permNames, scope: ur.scope, teamIds, managerOf, approvalLimit };
  }

  /**
   * The Policy Information Point (PIP): resolve the user's team memberships, management subtree, and
   * approval cap. Runs inside the caller's RLS transaction, so every query is tenant-scoped by
   * Postgres — no cross-tenant leakage and no explicit tenant predicate needed. `teamIds` feeds
   * `own_and_team` row scope; `managerOf` feeds the `manager_of` ABAC operator (the user ids this
   * user manages); `approvalLimit` feeds the amount-cap ABAC deny-override.
   *
   * `approvalLimit` is the MAX non-null `approval_limit_minor` across the user's `user_roles` rows —
   * a user may hold >1 role, and the most permissive cap wins (a stricter tenant-wide ceiling can be
   * composed via a persisted deny policy; deny-overrides mean the stricter of the two applies). NULL
   * / no rows ⇒ `undefined` ⇒ no cap ⇒ unlimited (back-compat). Returned as a `number` (minor units;
   * BIGINT stringifies through the driver, so it is coerced) or `undefined`.
   */
  private async loadPipAttributes(
    userId: string,
    t: Transaction,
  ): Promise<{ teamIds: string[]; managerOf: string[]; approvalLimit?: number }> {
    const sequelize = getSequelize();
    const teamRows = await sequelize.query<{ team_id: string }>(
      `SELECT DISTINCT team_id FROM team_members WHERE user_id = $1`,
      { bind: [userId], type: QueryTypes.SELECT, transaction: t },
    );
    const managedRows = await sequelize.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM approval_hierarchy WHERE manager_id = $1`,
      { bind: [userId], type: QueryTypes.SELECT, transaction: t },
    );
    const capRows = await sequelize.query<{ approval_limit_minor: string | number | null }>(
      `SELECT MAX(approval_limit_minor) AS approval_limit_minor FROM user_roles WHERE user_id = $1`,
      { bind: [userId], type: QueryTypes.SELECT, transaction: t },
    );
    const rawCap = capRows[0]?.approval_limit_minor;
    const approvalLimit = rawCap == null ? undefined : Number(rawCap);
    return {
      teamIds: teamRows.map((r) => r.team_id),
      managerOf: managedRows.map((r) => r.user_id),
      approvalLimit: Number.isFinite(approvalLimit) ? approvalLimit : undefined,
    };
  }

  private toContact(row: UserManagementShape.UserRow): UserManagementShape.UserContactDto {
    return {
      userId: row.id,
      email: row.email,
    };
  }

  private uniqueContacts(
    contacts: UserManagementShape.UserContactDto[],
  ): UserManagementShape.UserContactDto[] {
    return [...new Map(contacts.map((c) => [c.userId, c])).values()];
  }
}
