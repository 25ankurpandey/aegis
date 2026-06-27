import type { Transaction } from 'sequelize';
import { UserManagementShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getIdentityContext } from '../models/database-context';

/**
 * Data access for tenant-level config + feature flags (`tenant_config` / `tenant_features`). Every
 * method takes the ambient RLS-scoped `Transaction` opened by the service via `withTenantTransaction`,
 * so a tenant only ever sees its own settings/flags.
 */
@provideSingleton(TenantConfigRepository)
export class TenantConfigRepository {
  async listConfig(t: Transaction): Promise<UserManagementShape.TenantConfigRow[]> {
    const { TenantConfig } = getIdentityContext();
    const rows = await TenantConfig.findAll({ transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.TenantConfigRow);
  }

  async getConfig(key: string, t: Transaction): Promise<UserManagementShape.TenantConfigRow | null> {
    const { TenantConfig } = getIdentityContext();
    const row = await TenantConfig.findOne({ where: { key }, transaction: t });
    return row ? (row.get({ plain: true }) as UserManagementShape.TenantConfigRow) : null;
  }

  /** Upsert the JSON value for a (tenant, key) pair. */
  async setConfig(
    data: UserManagementShape.SetConfigRow,
    t: Transaction,
  ): Promise<UserManagementShape.TenantConfigRow> {
    const { TenantConfig } = getIdentityContext();
    const existing = await TenantConfig.findOne({ where: { key: data.key }, transaction: t });
    const row = existing
      ? await existing.update({ value: data.value }, { transaction: t })
      : await TenantConfig.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.TenantConfigRow;
  }

  async listFeatures(t: Transaction): Promise<UserManagementShape.TenantFeatureRow[]> {
    const { TenantFeature } = getIdentityContext();
    const rows = await TenantFeature.findAll({ transaction: t });
    return rows.map((r) => r.get({ plain: true }) as UserManagementShape.TenantFeatureRow);
  }

  async getFeature(flag: string, t: Transaction): Promise<UserManagementShape.TenantFeatureRow | null> {
    const { TenantFeature } = getIdentityContext();
    const row = await TenantFeature.findOne({ where: { flag }, transaction: t });
    return row ? (row.get({ plain: true }) as UserManagementShape.TenantFeatureRow) : null;
  }

  /** Upsert the enabled state for a (tenant, flag) pair. */
  async setFeature(
    data: UserManagementShape.SetFeatureRow,
    t: Transaction,
  ): Promise<UserManagementShape.TenantFeatureRow> {
    const { TenantFeature } = getIdentityContext();
    const existing = await TenantFeature.findOne({ where: { flag: data.flag }, transaction: t });
    const row = existing
      ? await existing.update({ enabled: data.enabled }, { transaction: t })
      : await TenantFeature.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as UserManagementShape.TenantFeatureRow;
  }
}
