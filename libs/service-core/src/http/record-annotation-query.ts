import { ErrUtils } from '../errors/error-utils';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ParsedRecordAnnotationQuery {
  tagIds?: string[];
  tagIncludeNone?: boolean;
  tagMatch?: 'any' | 'all' | 'none';
  teamIds?: string[];
  teamIncludeNone?: boolean;
  assigneeIds?: string[];
  assigneeIncludeNone?: boolean;
  statuses?: string[];
}

export function parseRecordAnnotationQuery(
  query: Record<string, unknown>,
  currentUserId?: string | null,
): ParsedRecordAnnotationQuery {
  const tag = parseUuidList(query['tag'] ?? query['tags'], 'tag');
  const team = parseUuidList(query['team'] ?? query['teams'], 'team');
  const assignee = parseAssigneeList(query['assignee'] ?? query['assignees'], currentUserId);
  const tagMatch = parseTagMatch(query['tagMatch']);
  const statuses = parsePlainList(query['status'] ?? query['statuses']);

  return {
    ...(tag.ids.length ? { tagIds: tag.ids } : {}),
    ...(tag.includeNone ? { tagIncludeNone: true } : {}),
    ...(tagMatch ? { tagMatch } : {}),
    ...(team.ids.length ? { teamIds: team.ids } : {}),
    ...(team.includeNone ? { teamIncludeNone: true } : {}),
    ...(assignee.ids.length ? { assigneeIds: assignee.ids } : {}),
    ...(assignee.includeNone ? { assigneeIncludeNone: true } : {}),
    ...(statuses.length ? { statuses } : {}),
  };
}

export function hasRecordAnnotationScopeFilters(query: ParsedRecordAnnotationQuery): boolean {
  return Boolean(
    query.tagIds?.length ||
    query.tagIncludeNone ||
    query.teamIds?.length ||
    query.teamIncludeNone ||
    query.assigneeIds?.length ||
    query.assigneeIncludeNone,
  );
}

function parsePlainList(raw: unknown): string[] {
  return stringValues(raw)
    .flatMap((value) => value.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseUuidList(raw: unknown, field: string): { ids: string[]; includeNone: boolean } {
  const ids: string[] = [];
  let includeNone = false;
  for (const value of parsePlainList(raw)) {
    if (value.toUpperCase() === 'NONE') {
      includeNone = true;
      continue;
    }
    if (!UUID_RE.test(value)) throw ErrUtils.validation(`Invalid ${field} filter value`, { value });
    ids.push(value);
  }
  return { ids: unique(ids), includeNone };
}

function parseAssigneeList(
  raw: unknown,
  currentUserId?: string | null,
): { ids: string[]; includeNone: boolean } {
  const ids: string[] = [];
  let includeNone = false;
  for (const value of parsePlainList(raw)) {
    const normalized = value.toUpperCase();
    if (normalized === 'NONE') {
      includeNone = true;
      continue;
    }
    if (value.toLowerCase() === 'me') {
      if (!currentUserId)
        throw ErrUtils.validation('Cannot use assignee=me without an authenticated user');
      ids.push(currentUserId);
      continue;
    }
    if (!UUID_RE.test(value)) throw ErrUtils.validation('Invalid assignee filter value', { value });
    ids.push(value);
  }
  return { ids: unique(ids), includeNone };
}

function parseTagMatch(raw: unknown): 'any' | 'all' | 'none' | undefined {
  const value = stringValues(raw)[0];
  if (!value) return undefined;
  if (value === 'any' || value === 'all' || value === 'none') return value;
  throw ErrUtils.validation('Invalid tagMatch value', { value });
}

function stringValues(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  return typeof raw === 'string' ? [raw] : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
