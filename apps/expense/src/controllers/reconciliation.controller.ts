import type { Request, Response } from 'express';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { authenticate, authorize } from '@aegis/access-control';
import { RequestContext } from '@aegis/service-core';
import { Permission } from '@aegis/shared-enums';
import { ApiConstants } from '@aegis/shared-constants';
import {
  AppBrainService,
  listExpenseReportTotals,
  listUnresolvedDuplicateInvoices,
  listOrphanedExpenses,
} from '@aegis/db';
import {
  runReconciliation,
  buildReconciliationChecks,
  appBrainProposalSink,
  renderUiPage,
  type ReconciliationDataPort,
  type UiComponent,
} from '@aegis/ai-core';

/**
 * The RECONCILIATION surface: the HTTP face of the propose-only financial-integrity capability. It
 * lets a human trigger a reconciliation run for their tenant and read the findings it surfaced. It is a
 * READ + REMEMBER capability — it recomputes ground truth from the live domain tables (RLS-scoped) and
 * indexes each verified discrepancy into the app-brain as a recallable `audit_finding` proposal; it
 * NEVER writes to the domain. Guarded by `audit.view` (a financial-integrity read permission).
 *
 * The data port is built from the vetted `@aegis/db` reconciliation queries, pinned to the caller's
 * tenant; the checks are deterministic + propose-only, so no model key is needed.
 */
@controller(`/expense${ApiConstants.PublicPrefix}/_ai`)
export class ReconciliationController {
  /** Build the RLS-scoped data port for the current caller's tenant. */
  private portFor(tenantId: string): ReconciliationDataPort {
    return {
      listExpenseReportTotals: () => listExpenseReportTotals({ tenantId }),
      listUnresolvedDuplicateInvoices: () => listUnresolvedDuplicateInvoices({ tenantId }),
      listOrphanedExpenses: () => listOrphanedExpenses({ tenantId }),
    };
  }

  /**
   * POST /_ai/reconcile — run every reconciliation check for the caller's tenant, index the verified
   * findings into the app-brain, and return a summary. Idempotent per finding (upsert-by-ref).
   */
  @httpPost('/reconcile', authenticate(), authorize(Permission.AuditView))
  async run(req: Request, res: Response): Promise<void> {
    const tenantId = req.principal?.tenantId ?? RequestContext.tenantId();
    const service = new AppBrainService({ tenantId });
    const report = await runReconciliation({
      checks: buildReconciliationChecks(this.portFor(tenantId)),
      proposalSink: appBrainProposalSink(service),
    });
    res.status(200).json({
      data: {
        counts: report.counts,
        ranByCheck: report.ranByCheck,
        proposals: report.proposals.map((p) => ({
          checkId: p.checkId,
          status: p.status,
          subjectRef: p.finding.subjectRef,
          summary: p.finding.summary,
          recommendation: p.finding.recommendation,
        })),
      },
    });
  }

  /**
   * GET /_ai/reconcile/findings — the tenant's current reconciliation findings (the `audit_finding`
   * proposals in the app-brain), newest first. This is the human review surface.
   */
  @httpGet('/reconcile/findings', authenticate(), authorize(Permission.AuditView))
  async findings(req: Request, res: Response): Promise<void> {
    const tenantId = req.principal?.tenantId ?? RequestContext.tenantId();
    const service = new AppBrainService({ tenantId });
    const rows = await service.listByKind('audit_finding', 100);
    res.status(200).json({
      data: rows.map((r) => ({
        ref: r.ref,
        subject: r.subject,
        title: r.title,
        content: r.content,
        metadata: r.metadata,
        createdAt: r.createdAt,
      })),
    });
  }

  /**
   * GET /_ai/reconcile/findings.html — the same findings rendered as an openable HTML review page via
   * the generative-UI renderer (UI-as-data → HTML). Makes the capability visible in a browser with no
   * front-end build. Read-only; the rendered page carries no callable (host wires any action).
   */
  @httpGet('/reconcile/findings.html', authenticate(), authorize(Permission.AuditView))
  async findingsHtml(req: Request, res: Response): Promise<void> {
    const tenantId = req.principal?.tenantId ?? RequestContext.tenantId();
    const service = new AppBrainService({ tenantId });
    const rows = await service.listByKind('audit_finding', 100);
    const components: UiComponent[] = [
      {
        type: 'alert',
        tone: rows.length > 0 ? 'warning' : 'success',
        text:
          rows.length > 0
            ? `${rows.length} reconciliation finding(s) awaiting review.`
            : 'No open reconciliation findings — the books reconcile.',
      },
      {
        type: 'table',
        columns: ['Check', 'Subject', 'Finding'],
        rows: rows.map((r) => [
          (r.ref ?? '').split(':')[0] ?? '',
          r.subject ?? '',
          r.content ?? r.title ?? '',
        ]),
      },
    ];
    res
      .status(200)
      .type('html')
      .send(renderUiPage(components, { title: 'Aegis — Reconciliation findings' }));
  }
}
