import {
  Op,
  QueryTypes,
  literal,
  type Sequelize,
  type Transaction,
  type WhereOptions,
} from 'sequelize';
import { ErrUtils, RequestContext } from '@aegis/service-core';
import { ApprovalRecordType, TableName } from '@aegis/shared-enums';
import { getSequelize } from './connection';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RecordAnnotationFeatureFlag = 'record.annotations';

export interface RecordTagMutationOptions {
  tenantId?: string;
  recordType: ApprovalRecordType;
  recordId: string;
  tags: string[];
  transaction: Transaction;
  source?: 'manual' | 'workflow' | 'import';
  actorId?: string | null;
  existingTags?: string[] | null;
  createMissingCatalogTags?: boolean;
}

export interface RecordAnnotationListFilter {
  tagIds?: string[];
  tagIncludeNone?: boolean;
  tagMatch?: 'any' | 'all' | 'none';
  teamIds?: string[];
  teamIncludeNone?: boolean;
  assigneeIds?: string[];
  assigneeIncludeNone?: boolean;
  statuses?: string[];
}

interface TagRow {
  id: string;
  name: string;
}

function tenantIdOrContext(tenantId?: string): string {
  return tenantId ?? RequestContext.tenantId();
}

function actorOrContext(actorId?: string | null): string | null {
  return actorId !== undefined ? actorId : (RequestContext.tryGet()?.userId ?? null);
}

function normalized(values: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const v = value?.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

async function findTagById(tenantId: string, id: string, t: Transaction): Promise<TagRow | null> {
  const rows = await getSequelize().query<TagRow>(
    `SELECT id, name FROM "${TableName.Tags}"
       WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND is_active = true
       LIMIT 1`,
    { bind: [tenantId, id], type: QueryTypes.SELECT, transaction: t },
  );
  return rows[0] ?? null;
}

async function findTagByName(
  tenantId: string,
  name: string,
  t: Transaction,
): Promise<TagRow | null> {
  const rows = await getSequelize().query<TagRow>(
    `SELECT id, name FROM "${TableName.Tags}"
       WHERE tenant_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND is_active = true
       LIMIT 1`,
    { bind: [tenantId, name], type: QueryTypes.SELECT, transaction: t },
  );
  return rows[0] ?? null;
}

async function createTag(
  tenantId: string,
  name: string,
  actorId: string | null,
  t: Transaction,
): Promise<TagRow> {
  const rows = await getSequelize().query<TagRow>(
    `INSERT INTO "${TableName.Tags}" (tenant_id, name, is_active, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, true, $3, $3, now(), now())
       RETURNING id, name`,
    { bind: [tenantId, name, actorId], type: QueryTypes.SELECT, transaction: t },
  );
  return rows[0];
}

async function resolveTag(
  tenantId: string,
  value: string,
  t: Transaction,
  createMissing: boolean,
  actorId: string | null,
): Promise<TagRow> {
  const found = UUID_RE.test(value)
    ? await findTagById(tenantId, value, t)
    : await findTagByName(tenantId, value, t);
  if (found) return found;
  if (!createMissing || UUID_RE.test(value)) {
    throw ErrUtils.validation('Unknown tag', { tag: value });
  }
  return createTag(tenantId, value, actorId, t);
}

async function insertRecordTag(
  tenantId: string,
  recordType: ApprovalRecordType,
  recordId: string,
  tagId: string,
  source: string,
  actorId: string | null,
  t: Transaction,
): Promise<boolean> {
  const rows = await getSequelize().query<{ id: string }>(
    `INSERT INTO "${TableName.RecordTags}"
       (tenant_id, record_type, record_id, tag_id, source, added_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id, record_type, record_id, tag_id) DO NOTHING
       RETURNING id`,
    {
      bind: [tenantId, recordType, recordId, tagId, source, actorId],
      type: QueryTypes.SELECT,
      transaction: t,
    },
  );
  return rows.length > 0;
}

export async function listRecordTagNames(
  tenantId: string,
  recordType: ApprovalRecordType,
  recordId: string,
  t: Transaction,
): Promise<string[]> {
  const rows = await getSequelize().query<{ name: string }>(
    `SELECT t.name
       FROM "${TableName.RecordTags}" rt
       JOIN "${TableName.Tags}" t ON t.id = rt.tag_id AND t.tenant_id = rt.tenant_id
       WHERE rt.tenant_id = $1 AND rt.record_type = $2 AND rt.record_id = $3
       ORDER BY rt.created_at ASC, t.name ASC`,
    { bind: [tenantId, recordType, recordId], type: QueryTypes.SELECT, transaction: t },
  );
  return rows.map((row) => row.name);
}

export async function attachRecordTags(
  opts: RecordTagMutationOptions,
): Promise<{ tags: string[]; added: string[] }> {
  const tenantId = tenantIdOrContext(opts.tenantId);
  const actorId = actorOrContext(opts.actorId);
  const t = opts.transaction;
  const existing = normalized(opts.existingTags ?? []);
  const requested = normalized(opts.tags);
  const desired = normalized([...existing, ...requested]);
  const existingSet = new Set(existing.map((tag) => tag.toLowerCase()));
  const added: string[] = [];

  for (const raw of desired) {
    const tag = await resolveTag(tenantId, raw, t, opts.createMissingCatalogTags ?? false, actorId);
    await insertRecordTag(
      tenantId,
      opts.recordType,
      opts.recordId,
      tag.id,
      opts.source ?? 'manual',
      actorId,
      t,
    );
    if (
      requested.some((item) => item.toLowerCase() === raw.toLowerCase()) &&
      !existingSet.has(tag.name.toLowerCase())
    ) {
      added.push(tag.name);
    }
  }

  const current = await listRecordTagNames(tenantId, opts.recordType, opts.recordId, t);
  return { tags: current.length > 0 ? current : desired, added: normalized(added) };
}

export async function detachRecordTags(
  opts: RecordTagMutationOptions,
): Promise<{ tags: string[]; removed: string[] }> {
  const tenantId = tenantIdOrContext(opts.tenantId);
  const actorId = actorOrContext(opts.actorId);
  const t = opts.transaction;
  const removed: string[] = [];

  for (const raw of normalized(opts.tags)) {
    const tag = await resolveTag(tenantId, raw, t, false, actorId);
    await getSequelize().query(
      `DELETE FROM "${TableName.RecordTags}"
         WHERE tenant_id = $1 AND record_type = $2 AND record_id = $3 AND tag_id = $4`,
      {
        bind: [tenantId, opts.recordType, opts.recordId, tag.id],
        type: QueryTypes.DELETE,
        transaction: t,
      },
    );
    removed.push(tag.name);
  }

  const current = await listRecordTagNames(tenantId, opts.recordType, opts.recordId, t);
  return { tags: current, removed: normalized(removed) };
}

export function withRecordAnnotationListFilters(
  baseWhere: WhereOptions,
  opts: RecordAnnotationListFilter,
  cfg: { tableName: TableName; recordType: ApprovalRecordType; sequelize: Sequelize },
): WhereOptions {
  const where = { ...baseWhere } as Record<string | symbol, unknown>;
  const and = [...((where[Op.and] as unknown[]) ?? [])];

  if (opts.statuses && opts.statuses.length > 0) {
    where['status'] = opts.statuses.length === 1 ? opts.statuses[0] : { [Op.in]: opts.statuses };
  }

  const teamOr: unknown[] = [];
  if (opts.teamIds && opts.teamIds.length > 0) teamOr.push({ team_id: { [Op.in]: opts.teamIds } });
  if (opts.teamIncludeNone) teamOr.push({ team_id: null });
  if (teamOr.length === 1) and.push(teamOr[0]);
  if (teamOr.length > 1) and.push({ [Op.or]: teamOr });

  const assigneeOr: unknown[] = [];
  if (opts.assigneeIds && opts.assigneeIds.length > 0) {
    assigneeOr.push({ assignee_id: { [Op.in]: opts.assigneeIds } });
  }
  if (opts.assigneeIncludeNone) assigneeOr.push({ assignee_id: null });
  if (assigneeOr.length === 1) and.push(assigneeOr[0]);
  if (assigneeOr.length > 1) and.push({ [Op.or]: assigneeOr });

  const tagPredicate = tagFilterPredicate(opts, cfg);
  if (tagPredicate) and.push(literal(tagPredicate));

  if (and.length > 0) where[Op.and] = and;
  return where as WhereOptions;
}

function tagFilterPredicate(
  opts: RecordAnnotationListFilter,
  cfg: { tableName: TableName; recordType: ApprovalRecordType; sequelize: Sequelize },
): string | null {
  const tagIds = normalized(opts.tagIds ?? []);
  const match = opts.tagMatch ?? 'any';
  if (tagIds.length === 0 && !opts.tagIncludeNone) return null;

  const table = `"${cfg.tableName}"`;
  const recordMatch = `rt.tenant_id = ${table}."tenant_id" AND rt.record_type = ${cfg.sequelize.escape(cfg.recordType)} AND rt.record_id = ${table}."id"`;
  const selectedTags = tagIds.map((id) => cfg.sequelize.escape(id)).join(', ');
  const hasNoTags = `NOT EXISTS (SELECT 1 FROM "${TableName.RecordTags}" rt WHERE ${recordMatch})`;

  if (tagIds.length === 0) return hasNoTags;

  const hasAny = `EXISTS (SELECT 1 FROM "${TableName.RecordTags}" rt WHERE ${recordMatch} AND rt.tag_id IN (${selectedTags}))`;
  const hasAll = `(SELECT COUNT(DISTINCT rt.tag_id) FROM "${TableName.RecordTags}" rt WHERE ${recordMatch} AND rt.tag_id IN (${selectedTags})) = ${tagIds.length}`;
  const hasNone = `NOT EXISTS (SELECT 1 FROM "${TableName.RecordTags}" rt WHERE ${recordMatch} AND rt.tag_id IN (${selectedTags}))`;

  const selected = match === 'all' ? hasAll : match === 'none' ? hasNone : hasAny;
  return opts.tagIncludeNone ? `(${selected} OR ${hasNoTags})` : selected;
}
