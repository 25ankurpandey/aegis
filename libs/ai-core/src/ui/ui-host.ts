import type { CeremonyEvidence } from '../execution/supervised-write';
import type { DangerDecision } from '../danger/types';

/**
 * @aegis/ai-core / ui — the interactive HOST for the generative-UI renderer.
 *
 * The renderer (`render-html.ts`) emits data-only HTML: a form carries `data-submit-tool`, an approval
 * card's buttons carry `data-action` — but NO callable. The HOST is what wires those references back to
 * the governed route, preserving the invariant "the UI never embeds the callable; the host resolves the
 * string reference to a guarded route (authenticate → authorize → validate → RLS → audit)".
 *
 * This module is that host, in two layers:
 *   1. PURE, TESTABLE CONTRACT — {@link actRequest} / {@link confirmRequest} build the exact HTTP
 *      request descriptors for the two-step supervised flow (`POST /_ai/act`, `POST /_ai/act/:id/confirm`),
 *      and {@link evidenceForAction} maps an approval-card action + the SERVER-computed danger decision to
 *      the {@link CeremonyEvidence} to submit (or `null` to NOT execute — a reject/cancel).
 *   2. A BROWSER BOOTSTRAP — {@link AEGIS_UI_HOST_SCRIPT}, a self-contained vanilla-JS string that reads a
 *      `window.__AEGIS_UI__` config (baseUrl + bearer token + tenant), wires `form[data-submit-tool]` and
 *      `button[data-action]`, and mirrors the pure contract. It is INCLUDED by `renderUiPage({interactive})`
 *      but is provided by the embedding host, never by a descriptor.
 *
 * NOTE (auth): a browser must present the caller's bearer JWT + `x-tenant-id`; production browser sessions
 * (cookie/passkey) are a separate concern — the host reads them from the injected config.
 */

/** Config the embedding page provides to the host bootstrap (never emitted by a descriptor). */
export interface UiHostConfig {
  /** Base URL of the running service, e.g. `https://api.example.com/expense/v1`. */
  baseUrl: string;
  /** The caller's bearer JWT. */
  token: string;
  /** The tenant the calls run in (sent as `x-tenant-id`; the core re-checks it against the token). */
  tenantId: string;
}

/** A fully-described HTTP request (transport-agnostic) the host will execute with `fetch`. */
export interface HttpRequestDescriptor {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

function authHeaders(config: UiHostConfig): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${config.token}`,
    'x-tenant-id': config.tenantId,
  };
}

/** Build the `POST /_ai/act` request that PROPOSES a tool call (the governed core gates it). */
export function actRequest(
  config: UiHostConfig,
  toolName: string,
  args: Record<string, unknown>,
): HttpRequestDescriptor {
  return {
    url: `${config.baseUrl}/_ai/act`,
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ toolName, args }),
  };
}

/** Build the `POST /_ai/act/:id/confirm` request that submits the human's ceremony evidence. */
export function confirmRequest(
  config: UiHostConfig,
  pendingId: string,
  evidence: CeremonyEvidence,
): HttpRequestDescriptor {
  return {
    url: `${config.baseUrl}/_ai/act/${encodeURIComponent(pendingId)}/confirm`,
    method: 'POST',
    headers: authHeaders(config),
    body: JSON.stringify({ evidence }),
  };
}

/** Action labels that DECLINE an action — they never produce evidence, so nothing executes. */
const DECLINE_ACTIONS = new Set(['reject', 'cancel', 'deny', 'dismiss', 'decline']);

/**
 * Map an approval-card action + the danger decision to the {@link CeremonyEvidence} to submit, or `null`
 * to NOT execute (a decline). The evidence shape is dictated by the SERVER-computed ceremony — the host
 * never invents a ceremony; it only packages the human's response to the one the core required.
 *
 * `confirm` → one-click confirm; `typed_confirm` → the phrase the human typed (must match on the server);
 * `step_up` → a completed step-up assertion; `second_approver` → a granted approval record; `cooling_off`
 * → a confirm (the broker enforces the aging). `requiresOutOfBand` adds the out-of-band flag. An `allow`
 * or `block` ceremony has no confirm evidence (nothing to submit).
 */
export function evidenceForAction(
  action: string,
  decision: Pick<DangerDecision, 'ceremony' | 'requiresOutOfBand' | 'typedConfirmationPhrase'>,
  opts: { typedValue?: string; approvalId?: string; now?: number } = {},
): CeremonyEvidence | null {
  if (DECLINE_ACTIONS.has(action.trim().toLowerCase())) return null;

  const now = opts.now ?? 0; // caller stamps a real clock; kept injectable so this stays pure/testable
  let evidence: CeremonyEvidence;
  switch (decision.ceremony) {
    case 'confirm':
    case 'cooling_off':
      evidence = { confirmed: true, confirmedAt: now };
      break;
    case 'typed_confirm':
      evidence = { typedConfirmation: opts.typedValue ?? '' };
      break;
    case 'step_up':
      evidence = { stepUp: { verified: true } };
      break;
    case 'second_approver':
      evidence = { approval: { approvalId: opts.approvalId ?? '', status: 'granted' } };
      break;
    default:
      return null; // allow / block — no confirm evidence to submit
  }
  if (decision.requiresOutOfBand) evidence.outOfBandConfirmed = true;
  return evidence;
}

/**
 * The browser bootstrap: a self-contained vanilla-JS host that wires the renderer's `data-*` elements to
 * the governed routes, mirroring the pure contract above. Included by `renderUiPage({ interactive: true })`;
 * the embedding page must set `window.__AEGIS_UI__ = { baseUrl, token, tenantId }` before it runs.
 */
export const AEGIS_UI_HOST_SCRIPT = String.raw`
(function () {
  var cfg = window.__AEGIS_UI__;
  if (!cfg) { console.warn('[aegis-ui] window.__AEGIS_UI__ not set; interactivity disabled'); return; }
  function headers() {
    return { 'content-type': 'application/json', 'authorization': 'Bearer ' + cfg.token, 'x-tenant-id': cfg.tenantId };
  }
  function out(msg, tone) {
    var el = document.getElementById('aegis-ui-result') || (function () {
      var d = document.createElement('div'); d.id = 'aegis-ui-result'; document.querySelector('main,body').appendChild(d); return d;
    })();
    var box = document.createElement('div'); box.className = 'alert alert-' + (tone || 'neutral'); box.textContent = msg;
    el.prepend(box);
  }
  function evidenceFor(action, decision) {
    var a = (action || '').trim().toLowerCase();
    if (['reject','cancel','deny','dismiss','decline'].indexOf(a) !== -1) return null;
    var ev;
    switch (decision.ceremony) {
      case 'confirm': case 'cooling_off': ev = { confirmed: true, confirmedAt: Date.now() }; break;
      case 'typed_confirm':
        ev = { typedConfirmation: window.prompt('Type to confirm: ' + (decision.typedConfirmationPhrase || '')) || '' }; break;
      case 'step_up': ev = { stepUp: { verified: true } }; break;
      case 'second_approver': ev = { approval: { approvalId: '', status: 'granted' } }; break;
      default: return null;
    }
    if (decision.requiresOutOfBand) ev.outOfBandConfirmed = true;
    return ev;
  }
  function renderCeremony(pendingId, decision) {
    var card = document.createElement('section'); card.className = 'approval-card';
    card.setAttribute('data-pending-id', pendingId);
    card.innerHTML = '<h3>Confirmation required: ' + decision.ceremony + '</h3>'
      + '<p class="ceremony">danger level ' + decision.level + '</p>'
      + '<div class="actions"><button data-action="confirm">confirm</button>'
      + '<button data-action="reject">reject</button></div>';
    card.__decision = decision;
    (document.getElementById('aegis-ui-result') || document.querySelector('main,body')).prepend(card);
  }
  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-submit-tool]'); if (!form) return;
    e.preventDefault();
    var toolName = form.getAttribute('data-submit-tool'); var args = {};
    form.querySelectorAll('[name]').forEach(function (i) {
      args[i.name] = i.type === 'checkbox' ? i.checked : (i.type === 'number' ? Number(i.value) : i.value);
    });
    fetch(cfg.baseUrl + '/_ai/act', { method: 'POST', headers: headers(), body: JSON.stringify({ toolName: toolName, args: args }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var d = res.data || res;
        if (d.status === 'needs_ceremony') { renderCeremony(d.pendingId, d.decision); out('Action needs a ceremony: ' + d.decision.ceremony, 'warning'); }
        else if (d.status === 'allow') { out('Executed.', 'success'); }
        else { out('Response: ' + JSON.stringify(d), 'neutral'); }
      })
      .catch(function (err) { out('Request failed: ' + err, 'danger'); });
  });
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-action]'); if (!btn) return;
    var card = btn.closest('.approval-card[data-pending-id]'); if (!card) return;
    e.preventDefault();
    var pendingId = card.getAttribute('data-pending-id'); var decision = card.__decision || {};
    var ev = evidenceFor(btn.getAttribute('data-action'), decision);
    if (ev === null) { out('Declined.', 'neutral'); card.remove(); return; }
    fetch(cfg.baseUrl + '/_ai/act/' + encodeURIComponent(pendingId) + '/confirm',
      { method: 'POST', headers: headers(), body: JSON.stringify({ evidence: ev }) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var d = res.data || res;
        out(d.executed ? 'Confirmed + executed.' : ('Not executed: ' + (d.refusedReason || 'ceremony not satisfied')), d.executed ? 'success' : 'warning');
        if (d.executed) card.remove();
      })
      .catch(function (err) { out('Confirm failed: ' + err, 'danger'); });
  });
})();
`;
