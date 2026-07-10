/**
 * ROW-SCOPE REGRESSION GATE. Statically scans the controllers of the services the T25 audit swept
 * (reporting/workflow/notification/user-management) and FAILS if any single-resource `/:id` route on a
 * tenant-OWNED record ships WITHOUT a row-scope mechanism (a `resource:` loader → checkRowScope, or a
 * known owner-scoped repo read) and is not a documented tenant-shared exception. This turns the T27
 * one-off audit into a standing guard: a new unfenced owned-resource route can never land unnoticed.
 */
import { scanControllerRowScope } from '../src/tool-registry/scan-controller-row-scope';

/**
 * Single-resource `/:id` routes that DELIBERATELY do not run checkRowScope, each with its reason. A new
 * owned-resource route that lacks a fence and is NOT listed here fails the gate. To resolve a failure:
 * add `authorize(perm, { resource: loader })` (row scope) — or, if the record is genuinely
 * tenant-shared/admin, add it here with a justification.
 */
const KNOWN_TENANT_SHARED = new Map<string, string>([
  // Workflow rules are tenant-shared AUTOMATION CONFIG (keyed by the rule, not a user) — like ERP
  // connectors. Any tenant member with the rule permission may view/run them; not a per-user record.
  ['GET /workflow/api/v1/rules/:id', 'tenant-shared automation config (like connectors)'],
  ['POST /workflow/api/v1/rules/:id/run', 'tenant-shared automation config (like connectors)'],
]);

describe('row-scope regression gate — owned-resource :id routes must run row scope or be allowlisted', () => {
  it('flags no NEW single-resource route lacking a row-scope fence', () => {
    const gaps = scanControllerRowScope().filter((g) => g.verdict !== 'ok');
    const unexpected = gaps.filter((g) => !KNOWN_TENANT_SHARED.has(`${g.method} ${g.path}`));
    // If this fails, a new owned-resource /:id route shipped without a fence — see the file header.
    expect(unexpected.map((g) => `${g.method} ${g.path} [${g.verdict}] — ${g.reason}`)).toEqual([]);
  });

  it('scanner sees the swept services (sanity: it actually parsed routes)', () => {
    const all = scanControllerRowScope();
    expect(all.length).toBeGreaterThan(0);
  });
});
