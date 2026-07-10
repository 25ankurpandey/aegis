/**
 * RENDER UI DEMO — make the generative UI-as-data layer VISIBLE. Builds a sample set of the
 * declarative `UiComponent` descriptors an agent turn can emit (an alert, a danger approval card, a
 * tool input form, a reconciliation-findings table) and writes a self-contained HTML page you can open
 * in a browser. No LLM key, no front-end build, no external assets.
 *
 * Run:
 *   TS_NODE_PROJECT=tsconfig.base.json TS_NODE_TRANSPILE_ONLY=true \
 *   TS_NODE_COMPILER_OPTIONS='{"module":"commonjs","esModuleInterop":true}' \
 *     node -r ts-node/register -r tsconfig-paths/register scripts/ui/render-ui-demo.ts
 *   # → writes scripts/ui/demo-ui.html — open it in a browser.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderUiPage, type UiComponent } from '@aegis/ai-core';

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
