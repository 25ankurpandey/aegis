/**
 * RENDER UI DEMO — make the generative UI-as-data layer VISIBLE. Builds a sample set of the
 * declarative `UiComponent` descriptors an agent turn can emit (an alert, a danger approval card, a
 * tool input form, a reconciliation-findings table) and writes a self-contained HTML page you can open
 * in a browser. No LLM key, no front-end build, no external assets.
 *
 * Two files are written:
 *   - demo-ui.html          — the STATIC page (data-only; the buttons are inert labels).
 *   - demo-ui.interactive.html — the INTERACTIVE page: the same descriptors plus the host bootstrap,
 *     pre-wired to a placeholder `window.__AEGIS_UI__`. Edit baseUrl/token/tenantId at the top of that
 *     file (or serve it from a route that injects the caller's real session) and the form + approval
 *     buttons drive the governed `POST /_ai/act` → `/_ai/act/:id/confirm` flow.
 *
 * Run:
 *   TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
 *     node -r ts-node/register -r tsconfig-paths/register scripts/ui/render-ui-demo.ts
 *   # → writes scripts/ui/demo-ui.html and demo-ui.interactive.html — open either in a browser.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderUiPage, type UiComponent, type UiHostConfig } from '@aegis/ai-core';

const components: UiComponent[] = [
  { type: 'alert', tone: 'warning', text: 'Reconciliation surfaced 3 findings needing review.' },
  {
    type: 'approvalCard',
    title: 'Approve $12,000 vendor payment',
    summary: 'Pay invoice INV-2048 to Acme Corp — flagged above the approver cap.',
    danger: {
      ceremony: 'second_approver',
      level: 4,
      reasons: ['moves money', 'above the approver amount cap', 'external payee'],
      typedConfirmationPhrase: 'APPROVE PAYMENT',
    },
    actions: ['confirm', 'reject'],
  },
  {
    type: 'form',
    title: 'Create expense',
    submitToolName: 'expense.report.create',
    fields: [
      { name: 'amount', label: 'Amount (minor)', kind: 'number', required: true },
      { name: 'merchant', label: 'Merchant', kind: 'string', required: true },
      { name: 'category', label: 'Category', kind: 'enum', required: false, enum: ['travel', 'meals', 'software'] },
      { name: 'billable', label: 'Billable', kind: 'boolean', required: false },
    ],
  },
  {
    type: 'table',
    columns: ['Check', 'Subject', 'Finding'],
    rows: [
      ['expense-report-total', 'RPT-1042', 'declared 20000 ≠ computed 18500'],
      ['duplicate-invoice', 'INV-2048', 'flagged duplicate of INV-2001'],
      ['orphaned-expense', 'EXP-77', 'attached to a soft-deleted report'],
    ],
  },
];

const html = renderUiPage(components, { title: 'Aegis — Generative UI demo' });
const out = join(__dirname, 'demo-ui.html');
writeFileSync(out, html, 'utf8');
process.stdout.write(`Wrote ${out} (${html.length} bytes). Open it in a browser.\n`);

// The INTERACTIVE variant: same descriptors + the host bootstrap, pointed at a placeholder session.
// Swap these for a running service + a real bearer JWT (or serve from a route that injects the caller's
// own session) and the form / approval buttons drive the governed two-step supervised flow.
const demoHostConfig: UiHostConfig = {
  baseUrl: 'http://localhost:3000/expense/v1',
  token: 'PASTE_A_BEARER_JWT_HERE',
  tenantId: 'PASTE_A_TENANT_ID_HERE',
};
const interactiveHtml = renderUiPage(components, {
  title: 'Aegis — Generative UI demo (interactive)',
  interactive: true,
  hostConfig: demoHostConfig,
});
const interactiveOut = join(__dirname, 'demo-ui.interactive.html');
writeFileSync(interactiveOut, interactiveHtml, 'utf8');
process.stdout.write(
  `Wrote ${interactiveOut} (${interactiveHtml.length} bytes). Set baseUrl/token/tenantId, then open it.\n`,
);
