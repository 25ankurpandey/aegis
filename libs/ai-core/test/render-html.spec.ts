import {
  renderComponentToHtml,
  renderUiToHtml,
  renderUiPage,
  escapeHtml,
} from '../src/ui/render-html';
import type { UiComponent } from '../src/ui/ui-spec';

describe('render-html — the server-side generative-UI renderer', () => {
  it('escapes text so a descriptor value can never inject markup (XSS-safe)', () => {
    const c: UiComponent = { type: 'text', text: '<script>alert(1)</script> & "quotes"' };
    const html = renderComponentToHtml(c);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(escapeHtml("a'b")).toBe('a&#39;b');
  });

  it('renders a badge and an alert with tone classes', () => {
    expect(renderComponentToHtml({ type: 'badge', label: 'OK', tone: 'success' })).toContain(
      'class="badge badge-success"',
    );
    expect(renderComponentToHtml({ type: 'alert', tone: 'danger', text: 'boom' })).toContain(
      'class="alert alert-danger"',
    );
  });

  it('renders a keyValue and a table', () => {
    const kv = renderComponentToHtml({
      type: 'keyValue',
      pairs: [{ label: 'Amount', value: '$5,000' }],
    });
    expect(kv).toContain('<dt>Amount</dt>');
    expect(kv).toContain('<dd>$5,000</dd>');

    const table = renderComponentToHtml({
      type: 'table',
      columns: ['Ref', 'Summary'],
      rows: [['inv-2', 'duplicate']],
    });
    expect(table).toContain('<th>Ref</th>');
    expect(table).toContain('<td>inv-2</td>');
  });

  it('renders a form with the right control per field kind + the submit tool as a data attribute (no inline JS)', () => {
    const form = renderComponentToHtml({
      type: 'form',
      title: 'Create expense',
      submitToolName: 'expense.create',
      fields: [
        { name: 'amount', label: 'Amount', kind: 'number', required: true },
        { name: 'billable', label: 'Billable', kind: 'boolean', required: false },
        { name: 'category', label: 'Category', kind: 'enum', required: false, enum: ['travel', 'meals'] },
      ],
    });
    expect(form).toContain('type="number"');
    expect(form).toContain('type="checkbox"');
    expect(form).toContain('<select');
    expect(form).toContain('<option value="travel">travel</option>');
    expect(form).toContain('data-submit-tool="expense.create"');
    // UI-as-data invariant: no inline event handler / no callable embedded.
    expect(form).not.toMatch(/onclick=|onsubmit=|<script/i);
  });

  it('renders an approval card with the SERVER-computed danger facts + action buttons (labels only)', () => {
    const card = renderComponentToHtml({
      type: 'approvalCard',
      title: 'Approve $12,000 payment',
      summary: 'Pay vendor Acme',
      danger: {
        ceremony: 'second_approver',
        level: 4,
        reasons: ['money', 'above approver cap'],
        typedConfirmationPhrase: 'APPROVE PAYMENT',
      },
      actions: ['confirm', 'reject'],
    });
    expect(card).toContain('second_approver');
    expect(card).toContain('danger level 4');
    expect(card).toContain('<li>money</li>');
    expect(card).toContain('<code>APPROVE PAYMENT</code>');
    expect(card).toContain('data-action="confirm"');
    expect(card).toContain('data-action="reject"');
    expect(card).not.toMatch(/onclick=|<script/i);
  });

  it('renderUiToHtml joins a list; renderUiPage wraps a self-contained page', () => {
    const components: UiComponent[] = [
      { type: 'text', text: 'hello' },
      { type: 'badge', label: 'new', tone: 'neutral' },
    ];
    const frag = renderUiToHtml(components);
    expect(frag).toContain('<p>hello</p>');
    expect(frag).toContain('badge-neutral');

    const page = renderUiPage(components, { title: 'Aegis Findings' });
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<title>Aegis Findings</title>');
    expect(page).toContain('<style>'); // inline CSS, no external asset (CSP-safe)
    expect(page).toContain('<p>hello</p>');
  });
});
