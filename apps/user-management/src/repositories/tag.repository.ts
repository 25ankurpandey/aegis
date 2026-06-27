import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for the `tags` catalog (Wave-6). Tenant-admin owns the catalog CRUD; every method takes
 * the ambient RLS-scoped `Transaction` opened by the service via `withTenantTransaction`.
 */
@provideSingleton(TagRepository)
export class TagRepository {
  async list(t: Transaction): Promise<UserManagementShape.TagRow[]> {
    const { Tag } = getIdentityContext();
    const rows = await Tag.findAll({ transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.TagRow);
  }

  async findById(id: string, t: Transaction): Promise<UserManagementShape.TagRow | null> {
    const { Tag } = getIdentityContext();
    const row = await Tag.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as UserManagementShape.TagRow) : null;
  }

  async create(
    data: UserManagementShape.CreateTagInput,
    t: Transaction,
  ): Promise<UserManagementShape.TagRow> {
    const { Tag } = getIdentityContext();
    const row = await Tag.create({ ...data, is_active: true }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.TagRow;
  }

  async update(
    id: string,
    patch: UserManagementShape.UpdateTagInput,
    t: Transaction,
  ): Promise<UserManagementShape.TagRow | null> {
    const { Tag } = getIdentityContext();
    const row = await Tag.findByPk(id, { transaction: t });
    if (!row) return null;
    await row.update(patch, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.TagRow;
  }

  async delete(id: string, t: Transaction): Promise<number> {
    const { Tag } = getIdentityContext();
    return Tag.destroy({ where: { id }, transaction: t });
  }
}
