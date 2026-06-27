import type { Transaction } from 'sequelize';
import { ApprovalShape } from '@aegis/shared-types';
import { provideSingleton } from '../ioc/container';
import { getApprovalContext } from '../models/database-context';

/**
 * Data access for `approval_hierarchy` (the tenant manager/reporting graph). The manager-based
 * resolver uses {@link findByUser} to find a submitter's manager. Tenant-scoped via the ambient
 * RLS transaction.
 */
@provideSingleton(HierarchyRepository)
export class HierarchyRepository {
  /** Upsert a user's manager edge. */
  async upsertEdge(
    data: { user_id: string; manager_id: string | null; depth?: number },
    t: Transaction,
  ): Promise<ApprovalShape.HierarchyRow> {
    const { Hierarchy } = getApprovalContext();
    const existing = await Hierarchy.findOne({ where: { user_id: data.user_id }, transaction: t });
    const row = existing
      ? await existing.update(
          { manager_id: data.manager_id, depth: data.depth ?? (existing.get('depth') as number) },
          { transaction: t },
        )
      : await Hierarchy.create({ ...data, depth: data.depth ?? 0 }, { transaction: t });
    return row.get({ plain: true }) as ApprovalShape.HierarchyRow;
  }

  /** Find a user's hierarchy edge (their manager + depth), if any. */
  async findByUser(userId: string, t: Transaction): Promise<ApprovalShape.HierarchyRow | null> {
    const { Hierarchy } = getApprovalContext();
    const row = await Hierarchy.findOne({ where: { user_id: userId }, transaction: t });
    return row ? (row.get({ plain: true }) as ApprovalShape.HierarchyRow) : null;
  }

  /** The reporting manager OF a user (one edge up, W3-05), or null at the org root / when unknown. */
  async managerOf(userId: string, t: Transaction): Promise<string | null> {
    const edge = await this.findByUser(userId, t);
    return edge?.manager_id ?? null;
  }

  /**
   * Walk the reporting chain from a user UP to `depth` managers (W3-05 manager_chain). Returns the
   * ordered list of manager ids nearest-first (`[directManager, grandManager, …]`), stopping early at
   * the org root or a missing edge. A cycle guard caps the walk at the requested depth. The starting
   * user is never included; duplicates (a degenerate self-managing edge) are dropped.
   */
  async managerChain(userId: string, depth: number, t: Transaction): Promise<string[]> {
    const chain: string[] = [];
    const seen = new Set<string>([userId]);
    let current = userId;
    for (let i = 0; i < Math.max(0, depth); i++) {
      const manager = await this.managerOf(current, t);
      if (!manager || seen.has(manager)) break;
      chain.push(manager);
      seen.add(manager);
      current = manager;
    }
    return chain;
  }
}
