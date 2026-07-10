/**
 * READ-ONLY ROW-SCOPE AUDIT of the services the T25 audit never swept: reporting, workflow,
 * notification, user-management. It answers, per single-resource route: does a `/:id`-style route on a
 * tenant-OWNED record run row-scope — either via `authorize(perm, { resource: loader })` (so
 * `checkRowScope` fires in the PEP) or an equivalent owner/team-scoped repo read? A route that does
 * neither lets an `own_only` / `own_and_team` principal reach a peer's row inside the same tenant (RLS
 * only bounds the TENANT, not the row).
 *
 * WHY A STATIC SCAN (not a live router walk). Booting each app's Express router needs its full infra
 * (Postgres/pgvector, Redis, the Inversify DI graph). To stay strictly read-only and infra-free, this
 * script STATICALLY parses each service's controllers — the `@httpGet/@httpPost/...` decorators — to
 * recover (method, path, permission) AND whether the `authorize(...)` call passes a `resource:` loader.
 * Unlike a pure router walk, a source scan CAN see the loader (it is source text, not a closure), so the
 * verdict is definitive for the loader dimension. A small curated allowlist records the routes whose
 * service/repo filters the single-resource read by owner/team (the notification-inbox pattern) so those
 * are correctly reported `ok`. The structural classification itself is delegated to the reusable
 * `auditRowScope` in @aegis/ai-core (libs/ai-core/src/tool-registry/row-scope-audit.ts).
 *
 * Read-only: it reads .ts source files only — no DB, no Redis, no network, no writes. Exits 0 (findings
 * are informational, not a script failure).
 *
 * HOW TO RUN (from the repo root; the repo has only tsconfig.base.json, so ts-node needs both the project
 * file and tsconfig-paths for the @aegis/* alias the classifier imports):
 *
 *   TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
 *     node -r ts-node/register -r tsconfig-paths/register scripts/security/audit-row-scope.ts
 *
 * Optionally pass `--gaps-only` to print only genuine + candidate gaps (drop the `ok` rows).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
// Import the classifier directly from its source module rather than the @aegis/ai-core barrel, so this
// read-only script runs BEFORE the barrel export line is wired (the caller adds
// `export * from './tool-registry/row-scope-audit'` to libs/ai-core/src/index.ts). Once wired, this may
// be switched to `from '@aegis/ai-core'` with no behavioural change.
import {
  auditRowScope,
  type AuditRoute,
  type RowScopeGap,
} from '../../libs/ai-core/src/tool-registry/row-scope-audit';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The services the T25 audit never swept, with their public route prefix (for display). */
const SERVICES = ['reporting', 'workflow', 'notification', 'user-management'] as const;
type Service = (typeof SERVICES)[number];

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
interface ParsedRoute extends AuditRoute {
  service: Service;
}

const HTTP_DECORATOR = /@http(Get|Post|Put|Patch|Delete)\s*\(([\s\S]*?)\)\s*(?:async\s+)?[A-Za-z0-9_]+\s*\(/g;
const CONTROLLER_PREFIX = /@controller\(\s*`([^`]*)`/;

/** Resolve a `${ApiConstants.PublicPrefix}` template to the concrete `/api/v1` used across services. */
function resolvePrefix(raw: string): string {
  return raw.replace(/\$\{ApiConstants\.PublicPrefix\}/g, '/api/v1');
}

/** Extract the dotted permission string(s) from an `authorize(Permission.X, ...)` / authorizeAny call. */
function extractPermissions(decoratorArgs: string): string[] {
  const perms: string[] = [];
  const re = /Permission\.([A-Za-z0-9_]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(decoratorArgs))) perms.push(PERMISSION_VALUES[m[1] as keyof typeof PERMISSION_VALUES] ?? m[1]!);
  return perms;
}

/** Does the `authorize(...)` call in this decorator pass a `resource:` loader (row-scope in the PEP)? */
function hasResourceLoader(decoratorArgs: string): boolean {
  // Match `authorize(<perm>, { ... resource: ... })` or authorizeAny([...], { resource: ... }).
  return /authorize(?:Any)?\s*\([\s\S]*resource\s*:/.test(decoratorArgs);
}

// Permission name→dotted-value map (mirrors libs/shared/enums/src/access.enum.ts). The dotted VALUE is
// what the admin-prefix classifier keys on, so this MUST cover every permission the four services use
// (an unmapped name falls back to the raw name and would mis-classify an admin route as owned). Kept
// inline to avoid importing the app DI graph; sourced from access.enum.ts.
const PERMISSION_VALUES = {
  // tenant / platform admin
  TenantManage: 'tenant.manage',
  TenantView: 'tenant.view',
  // identity & access administration (PAP)
  UserCreate: 'user.create',
  UserView: 'user.view',
  UserUpdate: 'user.update',
  UserInvite: 'user.invite',
  SessionView: 'session.view',
  SessionRevoke: 'session.revoke',
  RoleCreate: 'role.create',
  RoleView: 'role.view',
  RoleUpdate: 'role.update',
  RoleDelete: 'role.delete',
  RoleAssign: 'role.assign',
  PermissionView: 'permission.view',
  PolicyView: 'policy.view',
  PolicyManage: 'policy.manage',
  TeamManage: 'team.manage',
  OrgManage: 'org.manage',
  TagCreate: 'tag.create',
  TagUpdate: 'tag.update',
  TagDelete: 'tag.delete',
  TagList: 'tag.list',
  RecordTagAdd: 'record.tag.add',
  RecordTagRemove: 'record.tag.remove',
  RecordAssign: 'record.assign',
  TeamTagManage: 'team.tag.manage',
  // reporting
  ReportDefine: 'report.define',
  ReportRun: 'report.run',
  ReportView: 'report.view',
  // workflow
  RuleCreate: 'workflow.rule.create',
  RuleView: 'workflow.rule.view',
  RuleUpdate: 'workflow.rule.update',
  RuleRun: 'workflow.rule.run',
  // notification
  NotificationView: 'notification.view',
  // connectors (ERP)
  ConnectorManage: 'connector.manage',
  ConnectorPush: 'connector.push',
  // audit
  AuditView: 'audit.view',
} as const;

function parseController(service: Service, filePath: string): ParsedRoute[] {
  const src = readFileSync(filePath, 'utf8');
  const prefixMatch = CONTROLLER_PREFIX.exec(src);
  const prefix = prefixMatch ? resolvePrefix(prefixMatch[1]!) : '';
  const routes: ParsedRoute[] = [];
  let m: RegExpExecArray | null;
  HTTP_DECORATOR.lastIndex = 0;
  while ((m = HTTP_DECORATOR.exec(src))) {
    const method = m[1]!.toUpperCase();
    const args = m[2]!;
    const pathMatch = /^\s*['"`]([^'"`]+)['"`]/.exec(args);
    if (!pathMatch) continue;
    const routePath = prefix + pathMatch[1]!;
    const permissions = extractPermissions(args);
    const ownerScopedRepo = OWNER_SCOPED_REPO.has(`${service} ${method} ${routePath}`);
    routes.push({
      service,
      method,
      path: routePath,
      permissions,
      // A SOURCE scan (unlike a router walk) definitively sees loader presence/absence — so pass an
      // explicit boolean, which lets auditRowScope emit a CONFIRMED `no_resource_loader` verdict (rather
      // than a `candidate`) when there is neither a loader nor a known owner-scoped repo read.
      hasResourceLoader: hasResourceLoader(args),
      hasOwnerScopedRepo: ownerScopedRepo ? true : undefined,
    });
  }
  return routes;
}

function collectRoutes(): ParsedRoute[] {
  const all: ParsedRoute[] = [];
  for (const service of SERVICES) {
    const dir = join(REPO_ROOT, 'apps', service, 'src', 'controllers');
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.controller.ts'));
    } catch {
      process.stderr.write(`WARN: no controllers dir for ${service} at ${dir}\n`);
      continue;
    }
    for (const file of files) all.push(...parseController(service, join(dir, file)));
  }
  return all;
}

function verdictLabel(g: RowScopeGap): string {
  switch (g.verdict) {
    case 'ok':
      return 'y (ok)';
    case 'no_resource_loader':
      return 'N (GAP)';
    case 'candidate_no_resource_loader':
      return '? (candidate)';
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function main(): void {
  const gapsOnly = process.argv.includes('--gaps-only');
  const parsed = collectRoutes();

  // auditRowScope classifies; we re-associate each finding with its service for the report. Findings
  // come back in input order, and each (method,path) maps to exactly one parsed route, so we zip by key.
  const routeService = new Map<string, Service>();
  for (const r of parsed) routeService.set(`${r.method.toUpperCase()} ${r.path}`, r.service);

  const findings = auditRowScope(parsed as AuditRoute[]);
  const rows = gapsOnly ? findings.filter((g) => g.verdict !== 'ok') : findings;

  const header = `${pad('SERVICE', 16)}${pad('METHOD', 8)}${pad('ROUTE', 52)}${pad('HAS-SCOPE?', 16)}PERMISSION`;
  process.stdout.write(`\nROW-SCOPE AUDIT — reporting / workflow / notification / user-management\n`);
  process.stdout.write(`(single-resource /:id routes on tenant-OWNED records; admin/global + collection routes are excluded)\n\n`);
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(header.length + 8) + '\n');

  for (const g of rows) {
    const svc = routeService.get(`${g.method} ${g.path}`) ?? '?';
    process.stdout.write(
      `${pad(svc, 16)}${pad(g.method, 8)}${pad(g.path, 52)}${pad(verdictLabel(g), 16)}${g.permissions.join(', ')}\n`,
    );
  }

  const confirmed = findings.filter((g) => g.verdict === 'no_resource_loader').length;
  const candidates = findings.filter((g) => g.verdict === 'candidate_no_resource_loader').length;
  const ok = findings.filter((g) => g.verdict === 'ok').length;
  process.stdout.write(
    `\nSummary: ${findings.length} owned-resource single-resource route(s) — ` +
      `${ok} ok, ${candidates} candidate(s) (confirm loader in source), ${confirmed} confirmed gap(s).\n`,
  );
  process.stdout.write(`Reasons:\n`);
  for (const g of findings.filter((x) => x.verdict !== 'ok')) {
    process.stdout.write(`  - ${g.method} ${g.path}: ${g.reason}\n`);
  }
  process.stdout.write('\n');
  // Read-only audit: findings are informational; always exit 0.
  process.exit(0);
}

main();
