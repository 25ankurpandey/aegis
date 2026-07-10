import express from 'express';
import { authenticate, authorize } from '@aegis/access-control';
import { Permission } from '@aegis/shared-enums';
import {
  auditRowScope,
  rowScopeGapsOnly,
  type AuditRoute,
  type RowScopeGap,
} from '../src/tool-registry/row-scope-audit';

/**
 * Unit tests for the row-scope AUDIT — the check that flags single-resource, owned-resource routes that
 * carry no row-scope (no resource loader / no owner-scoped repo read). Pure + offline: routes are built
 * inline as AuditRoute[], and one case drives the real Express-app walk with real authenticate()/
 * authorize() stamps (no service DI graph — the walk never invokes handlers).
 */

const route = (over: Partial<AuditRoute> = {}): AuditRoute => ({
  method: 'GET',
  path: '/svc/api/v1/things/:id',
  permissions: [Permission.ReportView],
  ...over,
});

const byPath = (gaps: RowScopeGap[], p: string, m = 'GET') =>
  gaps.find((g) => g.path === p && g.method === m);

describe('auditRowScope — single-resource owned-resource classification', () => {
  it('flags a /:id owned-resource route with no loader as a CANDIDATE (loader is closure-captured)', () => {
    const gaps = auditRowScope([route()]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.verdict).toBe('candidate_no_resource_loader');
    expect(gaps[0]?.permissions).toEqual([Permission.ReportView]);
  });

  it('marks a route with a known resource loader as ok (checkRowScope runs in the PEP)', () => {
    const gaps = auditRowScope([route({ hasResourceLoader: true })]);
    expect(gaps[0]?.verdict).toBe('ok');
  });

  it('marks a route with an owner-scoped repo read as ok (equivalent row-scope)', () => {
    const gaps = auditRowScope([route({ hasOwnerScopedRepo: true })]);
    expect(gaps[0]?.verdict).toBe('ok');
  });

  it('reports a CONFIRMED gap when the caller knows there is no loader AND no owner-scoped repo', () => {
    const gaps = auditRowScope([route({ hasResourceLoader: false, hasOwnerScopedRepo: false })]);
    expect(gaps[0]?.verdict).toBe('no_resource_loader');
  });
});

describe('auditRowScope — routes that are NOT owned-resource gaps', () => {
  it('skips collection (no /:id) routes — that is the list-filter layer, not checkRowScope', () => {
    expect(auditRowScope([route({ path: '/svc/api/v1/things' })])).toHaveLength(0);
  });

  it('skips routes with no permission (not authz-bound / internal-auth only)', () => {
    expect(auditRowScope([route({ permissions: [] })])).toHaveLength(0);
  });

  it('skips admin / tenant-global routes (no per-row owner to scope against)', () => {
    const adminRoutes: AuditRoute[] = [
      route({ path: '/user-management/api/v1/sessions/:id', method: 'DELETE', permissions: [Permission.SessionRevoke] }),
      route({ path: '/user-management/api/v1/policies/:id', method: 'PATCH', permissions: [Permission.PolicyManage] }),
      route({ path: '/user-management/api/v1/teams/:teamId', method: 'DELETE', permissions: [Permission.TeamManage] }),
      route({ path: '/user-management/api/v1/users/:id', method: 'GET', permissions: [Permission.UserView] }),
      route({ path: '/workflow/api/v1/connectors/:kind', method: 'PUT', permissions: [Permission.ConnectorManage] }),
    ];
    expect(auditRowScope(adminRoutes)).toHaveLength(0);
  });

  it('skips excluded infra prefixes (health/api-docs)', () => {
    expect(auditRowScope([route({ path: '/health/:id' })])).toHaveLength(0);
  });

  it('does NOT treat a mixed admin+owned permission set as admin-only (any non-admin ⇒ owned)', () => {
    const gaps = auditRowScope([route({ permissions: [Permission.RoleView, Permission.ReportView] })]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.verdict).toBe('candidate_no_resource_loader');
  });
});

describe('auditRowScope — id param shapes + methods', () => {
  it('recognises named id params other than :id (e.g. :runId)', () => {
    const gaps = auditRowScope([route({ path: '/reporting/api/v1/report-runs/:runId' })]);
    expect(gaps[0]?.verdict).toBe('candidate_no_resource_loader');
  });

  it('flags POST/PATCH/PUT/DELETE sub-resource actions on a /:id path', () => {
    const gaps = auditRowScope([
      route({ path: '/workflow/api/v1/rules/:id/run', method: 'POST', permissions: [Permission.RuleRun] }),
      route({ path: '/reporting/api/v1/report-schedules/:id', method: 'DELETE', permissions: [Permission.ReportDefine] }),
    ]);
    expect(byPath(gaps, '/workflow/api/v1/rules/:id/run', 'POST')?.verdict).toBe('candidate_no_resource_loader');
    expect(byPath(gaps, '/reporting/api/v1/report-schedules/:id', 'DELETE')?.verdict).toBe(
      'candidate_no_resource_loader',
    );
  });
});

describe('auditRowScope — determinism, ordering, and helpers', () => {
  it('returns findings in input order and is deep-equal across runs (pure/deterministic)', () => {
    const routes: AuditRoute[] = [
      route({ path: '/reporting/api/v1/report-runs/:id' }),
      route({ path: '/reporting/api/v1/report-schedules/:id', method: 'PATCH', permissions: [Permission.ReportDefine] }),
    ];
    const a = auditRowScope(routes);
    const b = auditRowScope(routes);
    expect(a).toEqual(b);
    expect(a.map((g) => g.path)).toEqual([
      '/reporting/api/v1/report-runs/:id',
      '/reporting/api/v1/report-schedules/:id',
    ]);
  });

  it('does not mutate its input', () => {
    const routes: AuditRoute[] = [route()];
    const snapshot = JSON.parse(JSON.stringify(routes));
    auditRowScope(routes);
    expect(routes).toEqual(snapshot);
  });

  it('rowScopeGapsOnly drops ok verdicts', () => {
    const gaps = auditRowScope([
      route({ path: '/a/:id', hasResourceLoader: true }),
      route({ path: '/b/:id' }),
    ]);
    const only = rowScopeGapsOnly(gaps);
    expect(only.map((g) => g.path)).toEqual(['/b/:id']);
  });

  it('opts.adminPermissionPrefixes opts a bespoke permission out of the owned-resource class', () => {
    const gaps = auditRowScope([route({ permissions: ['report.view'] })], {
      adminPermissionPrefixes: ['report.'],
    });
    expect(gaps).toHaveLength(0);
  });
});

describe('auditRowScope — Express app walk (real authorize stamps)', () => {
  function buildApp(): express.Application {
    const app = express();
    // Owned-resource read, no loader ⇒ candidate gap.
    app.get('/reporting/api/v1/report-runs/:id', authenticate(), authorize(Permission.ReportView), (_q, s) =>
      s.sendStatus(200),
    );
    // Collection route ⇒ skipped.
    app.get('/reporting/api/v1/report-runs', authenticate(), authorize(Permission.ReportView), (_q, s) =>
      s.sendStatus(200),
    );
    // Admin /:id ⇒ skipped.
    app.delete('/user-management/api/v1/sessions/:id', authenticate(), authorize(Permission.SessionRevoke), (_q, s) =>
      s.sendStatus(200),
    );
    // Unguarded infra route ⇒ skipped (no permission stamp).
    app.get('/health', (_q, s) => s.sendStatus(200));
    return app;
  }

  it('walks the router and flags only the owned-resource /:id route as a candidate', () => {
    const gaps = auditRowScope(buildApp());
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.path).toBe('/reporting/api/v1/report-runs/:id');
    expect(gaps[0]?.method).toBe('GET');
    expect(gaps[0]?.verdict).toBe('candidate_no_resource_loader');
    expect(gaps[0]?.permissions).toEqual([String(Permission.ReportView)]);
  });
});
