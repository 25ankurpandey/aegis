/**
 * Live E2E — expense report create → submit → approval decide chain (FLOWS_v2 expense + shared
 * approval engine, E2E tier). SKIPPED unless `E2E_BASE_URL` is set.
 *
 * Note on the seeded demo tenant: its default expense policy L1 is `source: manager`, and the demo
 * tenant has NO `approval_hierarchy` edges, so the engine resolves an empty manager level and
 * auto-completes the chain (the documented "unconfigured org chart" behaviour — see
 * apps/cli/src/seeders/0004_approval_policies.ts). The assertions therefore accept EITHER outcome:
 *   - submit auto-completes → report reaches APPROVED with no pending slot, or
 *   - a concrete approver is configured → a pending slot exists and we drive the decide endpoint.
 * Both paths assert the report leaves OPEN and the decision surface behaves correctly.
 */
import { api, describeE2E, login, FIXTURES, uniqueSuffix } from './lib/client';

interface ReportRef {
  id: string;
  status: string;
}

describeE2E('live: expense approval chain', () => {
  it('creates, submits, and resolves an expense report through the shared engine', async () => {
    const { token } = await login(FIXTURES.tenantA);
    const tenantId = FIXTURES.tenantA.id;

    // 1) Create the report (OPEN).
    const created = await api<{ data: ReportRef }>('/expense/v1/reports', {
      method: 'POST',
      tenantId,
      token,
      body: { name: `E2E Trip ${uniqueSuffix()}`, currency: 'USD' },
    });
    expect(created.status).toBe(201);
    const reportId = created.body.data.id;
    expect(reportId).toBeTruthy();
    expect(created.body.data.status).toBe('open');

    // 2) Attach a line item so the report has a non-zero total.
    const attach = await api(`/expense/v1/reports/${reportId}/expenses`, {
      method: 'POST',
      tenantId,
      token,
      body: { amount: 4200, currency: 'USD', merchant: 'E2E Diner', description: 'dinner' },
    });
    expect(attach.status).toBe(200);

    // 3) Submit: OPEN → APPROVALS (or auto-complete to APPROVED when no approver resolves).
    const submitted = await api<{ data: ReportRef }>(`/expense/v1/reports/${reportId}/submit`, {
      method: 'POST',
      tenantId,
      token,
      body: { note: 'please review' },
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body.data.status).not.toBe('open');

    // 4) Decision surface. If a concrete approver was resolved, a pending slot exists → drive the
    //    canonical engine-backed decide endpoint. Otherwise the report already auto-completed.
    const pending = await api<{ data: Array<{ recordId?: string; reportId?: string }> }>(
      '/expense/v1/reports/approvals/pending',
      { tenantId, token },
    );
    expect(pending.status).toBe(200);

    const hasSlot = (pending.body.data ?? []).some(
      (slot) => slot.recordId === reportId || slot.reportId === reportId,
    );
    if (hasSlot) {
      const decided = await api<{ data: ReportRef }>(`/expense/v1/reports/${reportId}/decisions`, {
        method: 'POST',
        tenantId,
        token,
        body: { decision: 'approved', comment: 'looks good' },
      });
      expect(decided.status).toBe(200);
    }

    // 5) Final state: read the report back and assert it is in a post-submit state (never OPEN).
    const detail = await api<{ data: ReportRef }>(`/expense/v1/reports/${reportId}`, {
      tenantId,
      token,
    });
    expect(detail.status).toBe(200);
    expect(['approvals', 'approved']).toContain(detail.body.data.status);
  });

  it('denies the decide endpoint without a bearer token (PEP fail-closed)', async () => {
    const res = await api('/expense/v1/reports/00000000-0000-4000-8000-0000000000ff/decisions', {
      method: 'POST',
      tenantId: FIXTURES.tenantA.id,
      body: { decision: 'approved' },
    });
    expect(res.status).toBe(401);
  });
});
