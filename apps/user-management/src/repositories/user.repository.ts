import type { Transaction } from 'sequelize';
import { SystemRole, UserStatus } from '@aegis/shared-enums';
import { UserManagementShape } from '@aegis/shared-types';
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
    const { UserRole, Role, RolePermission, Permission } = getIdentityContext();
    const userRoles = await UserRole.findAll({ where: { user_id: userId }, transaction: t });
    if (userRoles.length === 0) return { roles: [], permissions: [], scope: 'own_only' };

    const ur = userRoles[0].get({ plain: true }) as { role_id: string; scope: string };
    const role = await Role.findByPk(ur.role_id, { transaction: t });
    const roleName = role ? (role.get({ plain: true }) as { name: string }).name : undefined;

    const rps = await RolePermission.findAll({ where: { role_id: ur.role_id }, transaction: t });
    const permIds = rps.map((r) => (r.get({ plain: true }) as { permission_id: string }).permission_id);
    const perms = permIds.length
      ? await Permission.findAll({ where: { id: permIds }, transaction: t })
      : [];
    const permNames = perms.map((p) => (p.get({ plain: true }) as { name: string }).name);

    return { roles: roleName ? [roleName] : [], permissions: permNames, scope: ur.scope };
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
