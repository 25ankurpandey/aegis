import { Sequelize } from 'sequelize';
import { Config } from '@aegis/service-core';

let sequelize: Sequelize | null = null;

/**
 * The shared Sequelize connection. The app connects as a NON-OWNER role (aegis_app) without
 * BYPASSRLS, so Row-Level Security is genuinely enforced (see docs/04-multi-tenancy.md).
 */
export function getSequelize(): Sequelize {
  if (!sequelize) {
    sequelize = new Sequelize(Config.require('DATABASE_URL'), {
      dialect: 'postgres',
      logging: false,
      pool: { max: Config.int('DB_POOL_MAX', 10), min: 1, idle: 10000 },
      define: {
        underscored: true,
        timestamps: true,
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    });
  }
  return sequelize;
}

export async function closeSequelize(): Promise<void> {
  if (sequelize) {
    await sequelize.close();
    sequelize = null;
  }
}

export async function pingDb(): Promise<boolean> {
  try {
    await getSequelize().authenticate();
    return true;
  } catch {
    return false;
  }
}
