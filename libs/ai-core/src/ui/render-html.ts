import type {
  UiApprovalCard,
  UiComponent,
  UiField,
  UiForm,
  UiKeyValue,
  UiTable,
} from './ui-spec';
import { AEGIS_UI_HOST_SCRIPT, type UiHostConfig } from './ui-host';

/** Embed a value as JSON inside a `<script>` safely (neutralize a `</script>` breakout in any string). */
function safeJsonScript(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

/**
 * @aegis/ai-core / ui — a reference SERVER-SIDE HTML renderer for the generative UI-as-data descriptors.
 *
 * `ui-spec.ts` deliberately describes only WHAT to show and leaves the renderer out of scope ("a web
 * canvas, a Unity surface, a mobile shell decides how to draw it"). This module is one such renderer: a
 * pure function that turns a {@link UiComponent} (or a list) into a self-contained, XSS-safe HTML string
 * so the agent loop is VISIBLE — an approval card, a tool form, a findings table — without any LLM key
 * or front-end build. It renders in a browser or an email client.
 *
 * IT PRESERVES THE UI-AS-DATA INVARIANT. Every string is HTML-escaped; the output carries NO inline
 * JavaScript and NO callable. Action references (a form's `submitToolName`, an approval card action) are
 * emitted as `data-*` attributes + labeled buttons ONLY — the host page wires them back to a governed
 * route (authenticate → authorize → validate → RLS → audit), which stays the sole path to any mutation.
 * A rendered page can therefore be served to an untrusted client without becoming an execution surface.
 */

/** HTML-escape a string so no descriptor value can inject markup or break out of an attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderKeyValue(c: UiKeyValue): string {
  const rows = c.pairs
    .map(
      (p) =>
        `<div class="kv-row"><dt>${escapeHtml(p.label)}</dt><dd>${escapeHtml(p.value)}</dd></div>`,
    )
    .join('');
  return `<dl class="kv">${rows}</dl>`;
}

function renderTable(c: UiTable): string {
  const head = c.columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('');
  const body = c.rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');
  return `<table class="grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderField(f: UiField): string {
  const id = `f_${escapeHtml(f.name)}`;
  const req = f.required ? ' required aria-required="true"' : '';
  let control: string;
  if (f.kind === 'boolean') {
    control = `<input id="${id}" name="${escapeHtml(f.name)}" type="checkbox"${req} />`;
  } else if (f.kind === 'enum') {
    const opts = (f.enum ?? [])
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
      .join('');
    control = `<select id="${id}" name="${escapeHtml(f.name)}"${req}>${opts}</select>`;
  } else {
    const inputType = f.kind === 'number' ? 'number' : 'text';
    const fmt = f.format ? ` data-format="${escapeHtml(f.format)}"` : '';
    control = `<input id="${id}" name="${escapeHtml(f.name)}" type="${inputType}"${fmt}${req} />`;
  }
  return `<div class="field"><label for="${id}">${escapeHtml(f.label)}${f.required ? ' *' : ''}</label>${control}</div>`;
}

function renderForm(c: UiForm): string {
  const title = c.title ? `<h3>${escapeHtml(c.title)}</h3>` : '';
  const fields = c.fields.map(renderField).join('');
  // The submit tool is a STRING reference carried in a data attribute — the host wires it to the
  // governed route. No action/handler is embedded here (UI-as-data invariant).
  const submit = c.submitToolName
    ? `<button type="submit" data-submit-tool="${escapeHtml(c.submitToolName)}">${escapeHtml(c.submitToolName)}</button>`
    : '';
  const tool = c.submitToolName ? ` data-submit-tool="${escapeHtml(c.submitToolName)}"` : '';
  return `<form class="form"${tool}>${title}${fields}${submit}</form>`;
}

function renderApprovalCard(c: UiApprovalCard): string {
  const reasons = c.danger.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('');
  const phrase = c.danger.typedConfirmationPhrase
    ? `<p class="typed">Type to confirm: <code>${escapeHtml(c.danger.typedConfirmationPhrase)}</code></p>`
    : '';
  // Actions are LABELS only; the host binds each to a governed route.
  const actions = c.actions
    .map((a) => `<button data-action="${escapeHtml(a)}">${escapeHtml(a)}</button>`)
    .join('');
  return (
    `<section class="approval-card danger-${escapeHtml(String(c.danger.level))}">` +
    `<h3>${escapeHtml(c.title)}</h3>` +
    `<p class="summary">${escapeHtml(c.summary)}</p>` +
    `<p class="ceremony">Ceremony: <strong>${escapeHtml(c.danger.ceremony)}</strong> (danger level ${escapeHtml(String(c.danger.level))})</p>` +
    `<ul class="reasons">${reasons}</ul>${phrase}` +
    `<div class="actions">${actions}</div>` +
    `</section>`
  );
}

/** Render a single {@link UiComponent} to an HTML fragment (XSS-safe, no inline JS). */
export function renderComponentToHtml(c: UiComponent): string {
  switch (c.type) {
    case 'text':
      return `<p>${escapeHtml(c.text)}</p>`;
    case 'badge':
      return `<span class="badge badge-${escapeHtml(c.tone)}">${escapeHtml(c.label)}</span>`;
    case 'alert':
      return `<div class="alert alert-${escapeHtml(c.tone)}">${escapeHtml(c.text)}</div>`;
    case 'keyValue':
      return renderKeyValue(c);
    case 'table':
      return renderTable(c);
    case 'form':
      return renderForm(c);
    case 'approvalCard':
      return renderApprovalCard(c);
  }
}

/** Render one or many {@link UiComponent}s to an HTML fragment. */
export function renderUiToHtml(components: UiComponent | UiComponent[]): string {
  const list = Array.isArray(components) ? components : [components];
  return list.map(renderComponentToHtml).join('\n');
}

/** Minimal inline stylesheet so a rendered page is legible standalone (no external assets / CSP-safe). */
const BASE_STYLE = `
  :root { font-family: system-ui, sans-serif; line-height: 1.5; }
  body { max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  .badge { display:inline-block; padding:.1rem .5rem; border-radius:1rem; font-size:.8rem; }
  .badge-neutral{background:#eee} .badge-success{background:#d6f5d6} .badge-warning{background:#fff2cc} .badge-danger{background:#ffd6d6}
  .alert{padding:.75rem 1rem;border-radius:.4rem;margin:.5rem 0}
  .alert-neutral{background:#eef} .alert-success{background:#e6f7e6} .alert-warning{background:#fff7e0} .alert-danger{background:#fdecea}
  .kv{display:grid;grid-template-columns:auto 1fr;gap:.25rem .75rem} .kv-row{display:contents} dt{font-weight:600}
  table.grid{border-collapse:collapse;width:100%} .grid th,.grid td{border:1px solid #ddd;padding:.4rem .6rem;text-align:left}
  .form .field{margin:.5rem 0;display:flex;flex-direction:column} .form label{font-weight:600;font-size:.9rem}
  .approval-card{border:1px solid #e0b4b4;border-radius:.5rem;padding:1rem;background:#fff8f8;margin:1rem 0}
  .approval-card .ceremony{color:#a33} .actions button,.form button{margin-right:.5rem;padding:.4rem .8rem}
`;

/**
 * Wrap rendered components in a self-contained, openable HTML page (inline CSS; no external assets).
 *
 * When `opts.interactive` is set, the generative-UI HOST bootstrap ({@link AEGIS_UI_HOST_SCRIPT}) is
 * included so `data-submit-tool` forms and `data-action` buttons drive the governed `/_ai/act` flow. The
 * host reads its config from `window.__AEGIS_UI__ = { baseUrl, token, tenantId }`:
 *   - Pass `opts.hostConfig` and the SERVER emits that config script itself — legitimate when the server
 *     renders the page for an ALREADY-authenticated caller (their own token in their own response, like a
 *     cookie). The token value is JSON-embedded through {@link safeJsonScript} so it cannot break out.
 *   - Omit `opts.hostConfig` and the embedding page must set `window.__AEGIS_UI__` before the host runs.
 *
 * The descriptor/renderer never carries a token or a callable; the config is the caller's own session.
 */
export function renderUiPage(
  components: UiComponent | UiComponent[],
  opts: { title?: string; interactive?: boolean; hostConfig?: UiHostConfig } = {},
): string {
  const title = escapeHtml(opts.title ?? 'Aegis');
  const configScript =
    opts.interactive && opts.hostConfig
      ? `<script>window.__AEGIS_UI__ = ${safeJsonScript(opts.hostConfig)};</script>`
      : '';
  const host = opts.interactive ? `${configScript}<script>${AEGIS_UI_HOST_SCRIPT}</script>` : '';
  return (
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
    `<title>${title}</title><style>${BASE_STYLE}</style></head>` +
    `<body><main>${renderUiToHtml(components)}</main>${host}</body></html>`
  );
}
