import type { Transaction } from 'sequelize';
import { ApprovalShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getApprovalContext } from '../models/database-context';

/**
 * Data access for `approval_policies`. Every method takes the ambient RLS-scoped `Transaction`
 * opened by the engine via `withTenantTransaction`, so a tenant only ever reads/writes its own
 * policies.
 */
@provideSingleton(PolicyRepository)
export class PolicyRepository {
  /** Create a policy for a `(tenant, record_type)`. */
  async create(
    data: Partial<ApprovalShape.PolicyRow>,
    t: Transaction,
  ): Promise<ApprovalShape.PolicyRow> {
    const { Policy } = getApprovalContext();
    const row = await Policy.create({ ...data }, { transaction: t });
    return row.get({ plain: true }) as ApprovalShape.PolicyRow;
  }

  /** Look up a policy by id. */
  async findById(id: string, t: Transaction): Promise<ApprovalShape.PolicyRow | null> {
    const { Policy } = getApprovalContext();
    const row = await Policy.findByPk(id, { transaction: t });
    return row ? (row.get({ plain: true }) as ApprovalShape.PolicyRow) : null;
  }

  /**
   * Resolve the active policy governing a record type for the current tenant. Newest active policy
   * wins (a later agent layers default/fallback selection on top). Returns null when none is
   * configured — the engine then falls back to a built-in default single-level policy.
   */
  async findActiveForRecordType(
    recordType: string,
    t: Transaction,
  ): Promise<ApprovalShape.PolicyRow | null> {
    const { Policy } = getApprovalContext();
    const row = await Policy.findOne({
      where: { record_type: recordType, is_active: true },
      order: [['created_at', 'DESC']],
      transaction: t,
    });
    return row ? (row.get({ plain: true }) as ApprovalShape.PolicyRow) : null;
  }

  /** List all policies for the current tenant. */
  async listAll(t: Transaction): Promise<ApprovalShape.PolicyRow[]> {
    const { Policy } = getApprovalContext();
    const rows = await Policy.findAll({ order: [['created_at', 'DESC']], transaction: t });
    return rows.map((r) => r.get({ plain: true }) as ApprovalShape.PolicyRow);
  }
}
