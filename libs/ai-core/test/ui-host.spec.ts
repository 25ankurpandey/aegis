import {
  actRequest,
  confirmRequest,
  evidenceForAction,
  AEGIS_UI_HOST_SCRIPT,
  type UiHostConfig,
} from '../src/ui/ui-host';
import { renderUiPage } from '../src/ui/render-html';
import type { DangerDecision } from '../src/danger/types';

const config: UiHostConfig = {
  baseUrl: 'https://api.example.com/expense/v1',
  token: 'jwt-abc',
  tenantId: 't-1',
};

/** Minimal danger decision for a given ceremony (only the fields evidenceForAction reads). */
const decisionOf = (over: Partial<DangerDecision>): DangerDecision =>
  ({ ceremony: 'confirm', level: 1, reasons: [], ...over } as DangerDecision);

describe('ui-host — the interactive contract that wires data-* to the governed routes', () => {
  it('actRequest posts {toolName,args} to /_ai/act with bearer + tenant headers', () => {
    const req = actRequest(config, 'expense.report.create', { amount: 100 });
    expect(req).toMatchObject({ url: 'https://api.example.com/expense/v1/_ai/act', method: 'POST' });
    expect(req.headers).toMatchObject({
      authorization: 'Bearer jwt-abc',
      'x-tenant-id': 't-1',
      'content-type': 'application/json',
    });
    expect(JSON.parse(req.body)).toEqual({ toolName: 'expense.report.create', args: { amount: 100 } });
  });

  it('confirmRequest posts {evidence} to /_ai/act/:id/confirm (id url-encoded)', () => {
    const req = confirmRequest(config, 'pending/42', { confirmed: true });
    expect(req.url).toBe('https://api.example.com/expense/v1/_ai/act/pending%2F42/confirm');
    expect(JSON.parse(req.body)).toEqual({ evidence: { confirmed: true } });
  });

  describe('evidenceForAction maps the action + SERVER ceremony to the right evidence', () => {
    it('confirm ⇒ { confirmed:true }', () => {
      expect(evidenceForAction('confirm', decisionOf({ ceremony: 'confirm' }), { now: 123 })).toEqual({
        confirmed: true,
        confirmedAt: 123,
      });
    });
    it('typed_confirm ⇒ the typed phrase', () => {
      expect(
        evidenceForAction('confirm', decisionOf({ ceremony: 'typed_confirm' }), { typedValue: 'DELETE ALL' }),
      ).toEqual({ typedConfirmation: 'DELETE ALL' });
    });
    it('step_up ⇒ a completed step-up', () => {
      expect(evidenceForAction('confirm', decisionOf({ ceremony: 'step_up' }))).toEqual({
        stepUp: { verified: true },
      });
    });
    it('second_approver ⇒ a granted approval', () => {
      expect(
        evidenceForAction('confirm', decisionOf({ ceremony: 'second_approver' }), { approvalId: 'ap-9' }),
      ).toEqual({ approval: { approvalId: 'ap-9', status: 'granted' } });
    });
    it('requiresOutOfBand adds the out-of-band flag', () => {
      expect(
        evidenceForAction('confirm', decisionOf({ ceremony: 'confirm', requiresOutOfBand: true }), { now: 1 }),
      ).toEqual({ confirmed: true, confirmedAt: 1, outOfBandConfirmed: true });
    });
    it('a decline action (reject/cancel/deny) ⇒ null (nothing executes)', () => {
      for (const a of ['reject', 'Cancel', 'DENY', 'dismiss', 'decline']) {
        expect(evidenceForAction(a, decisionOf({ ceremony: 'confirm' }))).toBeNull();
      }
    });
    it('a non-confirming ceremony (allow/block) ⇒ null', () => {
      expect(evidenceForAction('confirm', decisionOf({ ceremony: 'allow' }))).toBeNull();
      expect(evidenceForAction('confirm', decisionOf({ ceremony: 'block' }))).toBeNull();
    });
  });

  it('renderUiPage({interactive}) includes the host bootstrap; the default page does not', () => {
    const components = [{ type: 'text' as const, text: 'hi' }];
    const plain = renderUiPage(components);
    const interactive = renderUiPage(components, { interactive: true });
    expect(plain).not.toContain('__AEGIS_UI__');
    expect(interactive).toContain('<script>');
    expect(interactive).toContain('__AEGIS_UI__');
    expect(interactive).toContain('/_ai/act');
  });

  it('the host bootstrap embeds no token and reads config from the page (never from a descriptor)', () => {
    expect(AEGIS_UI_HOST_SCRIPT).toContain('window.__AEGIS_UI__');
    expect(AEGIS_UI_HOST_SCRIPT).not.toContain('jwt-abc'); // the renderer never bakes in a token
  });

  it('renderUiPage({interactive, hostConfig}) emits the caller config; without hostConfig it does not', () => {
    const components = [{ type: 'text' as const, text: 'hi' }];
    const withConfig = renderUiPage(components, { interactive: true, hostConfig: config });
    expect(withConfig).toContain('window.__AEGIS_UI__ =');
    expect(withConfig).toContain('jwt-abc'); // the server injects the AUTHENTICATED caller's own token
    const noConfig = renderUiPage(components, { interactive: true });
    expect(noConfig).not.toContain('window.__AEGIS_UI__ ='); // still has the host, but no baked config
    expect(noConfig).toContain('<script>');
  });

  it('a config value that tries to break out of the <script> is neutralized', () => {
    const evil = renderUiPage([{ type: 'text' as const, text: 'x' }], {
      interactive: true,
      hostConfig: { ...config, tenantId: '</script><script>alert(1)</script>' },
    });
    expect(evil).not.toContain('</script><script>alert(1)');
    expect(evil).toContain('<\\/script>'); // the breakout is escaped inside the JSON string
  });
});
