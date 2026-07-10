/**
 * STATIC controller-source scanner for the row-scope audit — the reusable engine used by the
 * `row-scope-gate` regression test. (The T27 `scripts/security/audit-row-scope.ts` report predates this
 * module and keeps an equivalent inline copy; it can be switched to import from here.)
 *
 * Bootstrapping each service's live Express router needs Postgres/Redis/the DI graph and is not
 * read-only, so instead we STATICALLY parse each controller's `@httpGet/@httpPost/...` decorators to
 * recover (method, path, permission) and whether the `authorize(...)` call passes a `resource:` loader
 * (row-scope in the PEP). The parsed routes are then classified by {@link auditRowScope}. A source scan
 * (unlike a router walk) definitively sees loader presence/absence, so it yields CONFIRMED verdicts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { auditRowScope, type AuditRoute, type RowScopeGap } from './row-scope-audit';

/** The four services the T25 audit never swept — the default scan set (the row-scope gate's charter). */
export const DEFAULT_SCAN_SERVICES = ['reporting', 'workflow', 'notification', 'user-management'] as const;

/**
 * Routes whose service/repo is KNOWN to filter the single-resource read by owner (`user_id`) — an
 * equivalent row-scope even without a `resource:` loader. Verified by reading the service+repo:
 *   - notification getForUser/markRead → repo.findByIdForUser(id, userId) / markRead(id, userId).
 * Keyed by `<service> <METHOD> <path>`.
 */
const OWNER_SCOPED_REPO = new Set<string>([
  'notification GET /notification/api/v1/notifications/:id',
  'notification POST /notification/api/v1/notifications/:id/read',
]);

/** A route parsed out of a controller decorator, tagged with its owning service. */
export interface ScannedRoute extends AuditRoute {
  service: string;
}

const HTTP_DECORATOR =
  /@http(Get|Post|Put|Patch|Delete)\s*\(([\s\S]*?)\)\s*(?:async\s+)?[A-Za-z0-9_]+\s*\(/g;
const CONTROLLER_PREFIX = /@controller\(\s*`([^`]*)`/;

/** Resolve a `${ApiConstants.PublicPrefix}` template to the concrete `/api/v1` used across services. */
function resolvePrefix(raw: string): string {
  return raw.replace(/\$\{ApiConstants\.PublicPrefix\}/g, '/api/v1');
}

/** Extract dotted permission string(s) from an `authorize(Permission.X, ...)` / authorizeAny call. */
function extractPermissions(decoratorArgs: string): string[] {
  const perms: string[] = [];
  const re = /Permission\.([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decoratorArgs))) {
    perms.push(PERMISSION_VALUES[m[1] as keyof typeof PERMISSION_VALUES] ?? m[1]!);
  }
  return perms;
}

/** Does the `authorize(...)` call in this decorator pass a `resource:` loader (row-scope in the PEP)? */
function hasResourceLoader(decoratorArgs: string): boolean {
  return /authorize(?:Any)?\s*\([\s\S]*resource\s*:/.test(decoratorArgs);
}

// Permission name→dotted-value map. The dotted VALUE is what auditRowScope's admin-prefix classifier
// keys on, so this MUST cover every permission the scanned services use (an unmapped name falls back to
// the raw name and would mis-classify an admin route as owned). Sourced from access.enum.ts; kept inline
// to avoid importing the app DI graph.
const PERMISSION_VALUES = {
  TenantManage: 'tenant.manage', TenantView: 'tenant.view',
  UserCreate: 'user.create', UserView: 'user.view', UserUpdate: 'user.update', UserInvite: 'user.invite',
  SessionView: 'session.view', SessionRevoke: 'session.revoke',
  RoleCreate: 'role.create', RoleView: 'role.view', RoleUpdate: 'role.update', RoleDelete: 'role.delete',
  RoleAssign: 'role.assign', PermissionView: 'permission.view',
  PolicyView: 'policy.view', PolicyManage: 'policy.manage',
  TeamManage: 'team.manage', OrgManage: 'org.manage',
  TagCreate: 'tag.create', TagUpdate: 'tag.update', TagDelete: 'tag.delete', TagList: 'tag.list',
  RecordTagAdd: 'record.tag.add', RecordTagRemove: 'record.tag.remove', RecordAssign: 'record.assign',
  TeamTagManage: 'team.tag.manage',
  ReportDefine: 'report.define', ReportRun: 'report.run', ReportView: 'report.view',
  RuleCreate: 'workflow.rule.create', RuleView: 'workflow.rule.view', RuleUpdate: 'workflow.rule.update',
  RuleRun: 'workflow.rule.run',
  NotificationView: 'notification.view',
  ConnectorManage: 'connector.manage', ConnectorPush: 'connector.push',
  AuditView: 'audit.view',
} as const;

function parseController(service: string, filePath: string): ScannedRoute[] {
  const src = readFileSync(filePath, 'utf8');
  const prefixMatch = CONTROLLER_PREFIX.exec(src);
  const prefix = prefixMatch ? resolvePrefix(prefixMatch[1]!) : '';
  const routes: ScannedRoute[] = [];
  let m: RegExpExecArray | null;
  HTTP_DECORATOR.lastIndex = 0;
  while ((m = HTTP_DECORATOR.exec(src))) {
    const method = m[1]!.toUpperCase();
    const args = m[2]!;
    const pathMatch = /^\s*['"`]([^'"`]+)['"`]/.exec(args);
    if (!pathMatch) continue;
    const routePath = prefix + pathMatch[1]!;
    const ownerScopedRepo = OWNER_SCOPED_REPO.has(`${service} ${method} ${routePath}`);
    routes.push({
      service,
      method,
      path: routePath,
      permissions: extractPermissions(args),
      hasResourceLoader: hasResourceLoader(args),
      hasOwnerScopedRepo: ownerScopedRepo ? true : undefined,
    });
  }
  return routes;
}

/** Parse every controller of the given services into route descriptors. */
export function collectScannedRoutes(opts: { appsRoot?: string; services?: readonly string[] } = {}): ScannedRoute[] {
  const appsRoot = opts.appsRoot ?? resolve(__dirname, '..', '..', '..', '..', 'apps');
  const services = opts.services ?? DEFAULT_SCAN_SERVICES;
  const all: ScannedRoute[] = [];
  for (const service of services) {
    const dir = join(appsRoot, service, 'src', 'controllers');
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.controller.ts'));
    } catch {
      continue; // service without a controllers dir — skip
    }
    for (const file of files) all.push(...parseController(service, join(dir, file)));
  }
  return all;
}

/** Scan the services' controllers and return the row-scope classification for every owned-resource route. */
export function scanControllerRowScope(opts: { appsRoot?: string; services?: readonly string[] } = {}): RowScopeGap[] {
  return auditRowScope(collectScannedRoutes(opts) as AuditRoute[]);
}
