/**
 * Live E2E — cross-tenant Row-Level-Security isolation (FLOW-024 / FLOWS_v2 multi-tenancy, E2E tier).
 * SKIPPED unless `E2E_BASE_URL` is set.
 *
 * Two REAL seeded tenants (A = demo-org, B = demo-org-b — see apps/cli/src/seeders/0005_demo_tenant_b.ts).
 * Create a report as tenant A's admin, then prove tenant B's admin can NEVER read it (RLS makes the
 * row invisible → 404, not 403 — the row simply does not exist for tenant B), and that B's own report
 * is invisible to A. This is the genuine RLS check: Postgres runs the app under a NON-OWNER role with
 * FORCE ROW LEVEL SECURITY, scoped by the per-transaction `app.current_tenant` session var.
 */
import { api, describeE2E, login, FIXTURES, uniqueSuffix } from './lib/client';

interface ReportRef {
  id: string;
  status: string;
}

describeE2E('live: cross-tenant RLS isolation', () => {
  it('hides tenant A rows from tenant B and vice-versa', async () => {
    const a = await login(FIXTURES.tenantA);
    const b = await login(FIXTURES.tenantB);

    // Tenant A creates a report.
    const aReport = await api<{ data: ReportRef }>('/expense/v1/reports', {
      method: 'POST',
      tenantId: FIXTURES.tenantA.id,
      token: a.token,
      body: { name: `A-only ${uniqueSuffix()}`, currency: 'USD' },
    });
    expect(aReport.status).toBe(201);
    const aReportId = aReport.body.data.id;

    // Tenant B creates a report.
    const bReport = await api<{ data: ReportRef }>('/expense/v1/reports', {
      method: 'POST',
      tenantId: FIXTURES.tenantB.id,
      token: b.token,
      body: { name: `B-only ${uniqueSuffix()}`, currency: 'USD' },
    });
    expect(bReport.status).toBe(201);
    const bReportId = bReport.body.data.id;

    // A can read its own report.
    const aReadsOwn = await api(`/expense/v1/reports/${aReportId}`, {
      tenantId: FIXTURES.tenantA.id,
      token: a.token,
    });
    expect(aReadsOwn.status).toBe(200);

    // B cannot read A's report → RLS-invisible → 404 (NOT 200, NOT the row).
    const bReadsA = await api(`/expense/v1/reports/${aReportId}`, {
      tenantId: FIXTURES.tenantB.id,
      token: b.token,
    });
    expect(bReadsA.status).toBe(404);

    // A cannot read B's report → 404.
    const aReadsB = await api(`/expense/v1/reports/${bReportId}`, {
      tenantId: FIXTURES.tenantA.id,
      token: a.token,
    });
    expect(aReadsB.status).toBe(404);
  });

  it("never surfaces another tenant's rows in a list response", async () => {
    const a = await login(FIXTURES.tenantA);
    const marker = `LIST-A ${uniqueSuffix()}`;
    await api('/expense/v1/reports', {
      method: 'POST',
      tenantId: FIXTURES.tenantA.id,
      token: a.token,
      body: { name: marker, currency: 'USD' },
    });

    // Tenant B lists reports — the marker created under A must not appear.
    const b = await login(FIXTURES.tenantB);
    const bList = await api<{ data?: Array<{ name?: string }> }>('/expense/v1/reports?page=1&pageSize=100', {
      tenantId: FIXTURES.tenantB.id,
      token: b.token,
    });
    expect(bList.status).toBe(200);
    const names = (bList.body.data ?? []).map((r) => r.name);
    expect(names).not.toContain(marker);
  });
});
