import type { Transaction } from 'sequelize';
import { RequestContext } from '@aegis/service-core';
import { getActivityModel } from './activity-log.model';

/**
 * One business-timeline entry to append. `recordType` + `recordId` identify the subject record
 * (polymorphic), `action` is the verb (e.g. `submitted`, `approved`), and `details` carries any
 * structured context. `actorId` and `correlationId` default from the ambient RequestContext.
 */
export interface ActivityInput {
  recordType: string;
  recordId: string;
  action: string;
  details?: unknown;
  actorId?: string | null;
  correlationId?: string | null;
}

/** A plain, read-side view of one `activity_log` row (types stay LOCAL to this lib, like @aegis/audit). */
export interface ActivityEntry {
  id: string;
  tenantId: string;
  recordType: string;
  recordId: string;
  actorId: string | null;
  action: string;
  details: unknown;
  correlationId: string | null;
  createdAt: Date;
}

function toEntry(r: Record<string, unknown>): ActivityEntry {
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    recordType: r['record_type'] as string,
    recordId: r['record_id'] as string,
    actorId: (r['actor_id'] as string) ?? null,
    action: r['action'] as string,
    details: r['details'] ?? {},
    correlationId: (r['correlation_id'] as string) ?? null,
    createdAt: r['created_at'] as Date,
  };
}

/**
 * Shared, append-only business-activity logger. Records a polymorphic who-did-what timeline for any
 * record type on one tenant-scoped table — the same role `@aegis/audit` plays for security events,
 * this plays for business timelines. Always call within an RLS-scoped (tenant) transaction so RLS
 * binds `tenant_id` on both write and read.
 */
export const ActivityLogger = {
  /** Append one activity entry for the current tenant inside the supplied transaction. */
  async record(input: ActivityInput, t: Transaction): Promise<void> {
    const Activity = getActivityModel();
    await Activity.create(
      {
        tenant_id: RequestContext.tenantId(),
        record_type: input.recordType,
        record_id: input.recordId,
        actor_id: input.actorId ?? RequestContext.userId() ?? null,
        action: input.action,
        details: input.details ?? {},
        correlation_id: input.correlationId ?? RequestContext.correlationId(),
      },
      { transaction: t },
    );
  },

  /**
   * Return the timeline for one record, newest first. RLS scopes the read to the current tenant;
   * the `(tenant_id, record_type, record_id, created_at)` index backs the ordered scan.
   */
  async list(recordType: string, recordId: string, t: Transaction): Promise<ActivityEntry[]> {
    const Activity = getActivityModel();
    const rows = await Activity.findAll({
      where: { record_type: recordType, record_id: recordId },
      order: [
        ['created_at', 'DESC'],
        ['id', 'DESC'],
      ],
      transaction: t,
    });
    return rows.map((row) => toEntry(row.get({ plain: true }) as Record<string, unknown>));
  },
};
