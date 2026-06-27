import { DataTypes, type ModelStatic, type Model, type Sequelize } from 'sequelize';
import { modelOptions } from '@aegis/db';
import { TableName, EmploymentStatus } from '@aegis/shared-enums';

const uuidPk = { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 };
const tenantCol = { type: DataTypes.UUID, allowNull: false };

/** Defines the `employees` table (tenant-scoped; sensitive PII columns are AES-256-GCM encrypted). */
export function defineEmployee(s: Sequelize): ModelStatic<Model> {
  return s.define(
    TableName.Employees,
    {
      id: uuidPk,
      tenant_id: tenantCol,
      user_id: { type: DataTypes.UUID, allowNull: true },
      person_ref: { type: DataTypes.UUID, allowNull: true },
      legal_entity_id: { type: DataTypes.UUID, allowNull: true },
      employment_status: { type: DataTypes.STRING, allowNull: false, defaultValue: EmploymentStatus.Active },
      work_jurisdiction: { type: DataTypes.STRING, allowNull: false },
      residence_jurisdiction: { type: DataTypes.STRING, allowNull: true },
      bank_account_enc: { type: DataTypes.TEXT, allowNull: true },
      national_id_enc: { type: DataTypes.TEXT, allowNull: true },
      tax_identifier_enc: { type: DataTypes.TEXT, allowNull: true },
      created_by: { type: DataTypes.UUID, allowNull: true },
      updated_by: { type: DataTypes.UUID, allowNull: true },
      deleted_at: { type: DataTypes.DATE, allowNull: true },
    },
    // Optimistic locking (`lock_version`) protects concurrent edits to employee/PII records.
    { tableName: TableName.Employees, ...modelOptions({ paranoid: true, version: true }) },
  );
}
