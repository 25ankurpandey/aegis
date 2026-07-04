import type { AegisTurnResult } from '../src/orchestrator/agent-orchestrator';
import type { AegisTool } from '../src/tool-registry/types';
import type { DangerDecision } from '../src/danger/types';
import { renderTurn, toolInputForm } from '../src/ui/render-turn';
import type {
  UiApprovalCard,
  UiComponent,
  UiForm,
  UiKeyValue,
  UiTable,
} from '../src/ui/ui-spec';

/**
 * GENERATIVE UI (A2UI-shaped, UI-as-data). Fully offline/deterministic: build AegisTurnResult objects
 * and AegisTools inline (no server), assert each turn kind maps to the right UiComponent, and enforce
 * the load-bearing invariant that NO function ever appears anywhere in the produced descriptor.
 */

/** Deep-walk a value and fail if any function is reachable (the UI-as-data invariant). */
function assertNoFunctions(value: unknown, path = '$'): void {
  expect(typeof value).not.toBe('function');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assertNoFunctions(child, `${path}.${key}`);
    }
  }
}

describe('renderTurn — turn kind → UiComponent', () => {
  it('message → UiText', () => {
    const turn: AegisTurnResult = { kind: 'message', text: 'hello there' };
    const ui = renderTurn(turn);
    expect(ui).toEqual({ type: 'text', text: 'hello there' });
    assertNoFunctions(ui);
  });

  it('tool (ok, object body) → UiKeyValue of the body', () => {
    const turn: AegisTurnResult = {
      kind: 'tool',
      toolName: 'get_expense',
      args: { id: 'x' },
      result: { status: 200, ok: true, body: { id: 'e1', amount: 1500, currency: 'USD' } },
    };
    const ui = renderTurn(turn) as UiKeyValue;
    expect(ui.type).toBe('keyValue');
    expect(ui.pairs).toEqual([
      { label: 'id', value: 'e1' },
      { label: 'amount', value: '1500' },
      { label: 'currency', value: 'USD' },
    ]);
    assertNoFunctions(ui);
  });

  it('tool (ok, array-of-objects body) → UiTable', () => {
    const turn: AegisTurnResult = {
      kind: 'tool',
      toolName: 'list_expenses',
      args: {},
      result: {
        status: 200,
        ok: true,
        body: [
          { id: 'e1', amount: 100 },
          { id: 'e2', amount: 200, currency: 'EUR' },
        ],
      },
    };
    const ui = renderTurn(turn) as UiTable;
    expect(ui.type).toBe('table');
    expect(ui.columns).toEqual(['id', 'amount', 'currency']);
    expect(ui.rows).toEqual([
      ['e1', '100', ''],
      ['e2', '200', 'EUR'],
    ]);
    assertNoFunctions(ui);
  });

  it('tool (!ok) → UiAlert danger', () => {
    const turn: AegisTurnResult = {
      kind: 'tool',
      toolName: 'post_expense',
      args: {},
      result: { status: 403, ok: false, body: { error: 'forbidden' } },
    };
    const ui = renderTurn(turn);
    expect(ui.type).toBe('alert');
    expect(ui).toMatchObject({ tone: 'danger' });
    expect((ui as { text: string }).text).toContain('403');
    assertNoFunctions(ui);
  });

  it('refused → UiAlert warning carrying the reason', () => {
    const turn: AegisTurnResult = {
      kind: 'refused',
      reason: 'Model chose tool "x" which is not in the offered set.',
    };
    const ui = renderTurn(turn);
    expect(ui).toEqual({
      type: 'alert',
      tone: 'warning',
      text: 'Model chose tool "x" which is not in the offered set.',
    });
    assertNoFunctions(ui);
  });

  it('needs_ceremony → UiApprovalCard carrying the ceremony + reasons + typed phrase', () => {
    const tool: AegisTool = {
      name: 'delete_invoices',
      method: 'DELETE',
      path: '/billing/v1/invoices',
      permissions: ['invoice:delete'],
      requiresAuth: true,
      inputSchema: { type: 'object', properties: {} },
      inputSources: ['body'],
      description: 'Delete invoices',
      riskTier: 4,
    };
    const decision: DangerDecision = {
      ceremony: 'typed_confirm',
      level: 4,
      assessment: { level: 4, dimensions: { monetary: 4 }, reasons: ['bulk delete'] },
      requiresHuman: true,
      typedConfirmationPhrase: 'DELETE 42 invoice',
      reasons: ['bulk irreversible delete of financial records'],
    };
    const turn: AegisTurnResult = {
      kind: 'needs_ceremony',
      tool,
      toolName: tool.name,
      args: { filter: 'all' },
      decision,
    };
    const ui = renderTurn(turn) as UiApprovalCard;
    expect(ui.type).toBe('approvalCard');
    expect(ui.danger).toEqual({
      ceremony: 'typed_confirm',
      level: 4,
      reasons: ['bulk irreversible delete of financial records'],
      typedConfirmationPhrase: 'DELETE 42 invoice',
    });
    expect(ui.title).toContain('delete_invoices');
    expect(ui.summary).toContain('DELETE /billing/v1/invoices');
    expect(ui.actions).toEqual(['confirm', 'cancel']);
    assertNoFunctions(ui);
  });

  it('needs_ceremony without a typed phrase omits it from the card', () => {
    const tool: AegisTool = {
      name: 'notify_customer',
      method: 'POST',
      path: '/comms/v1/notify',
      permissions: ['comms:send'],
      requiresAuth: true,
      inputSchema: { type: 'object', properties: {} },
      inputSources: ['body'],
      description: 'Notify a customer',
    };
    const decision: DangerDecision = {
      ceremony: 'confirm',
      level: 1,
      assessment: { level: 1, dimensions: {}, reasons: [] },
      requiresHuman: true,
      reasons: ['external notification'],
    };
    const ui = renderTurn({
      kind: 'needs_ceremony',
      tool,
      toolName: tool.name,
      args: {},
      decision,
    }) as UiApprovalCard;
    expect(ui.danger.ceremony).toBe('confirm');
    expect('typedConfirmationPhrase' in ui.danger).toBe(false);
    assertNoFunctions(ui);
  });
});

describe('toolInputForm — inputSchema → UiForm', () => {
  const tool: AegisTool = {
    name: 'post_expense',
    method: 'POST',
    path: '/expense/v1/expenses',
    permissions: ['expense:create'],
    requiresAuth: true,
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'integer' },
        id: { type: 'string', format: 'uuid' },
        currency: { type: 'string', enum: ['USD', 'EUR', 'GBP'] },
        approved: { type: 'boolean' },
      },
      required: ['amount', 'id'],
    },
    inputSources: ['body', 'params'],
    description: 'Create an expense',
  };

  it('derives typed, required fields with enum/format passthrough', () => {
    const form: UiForm = toolInputForm(tool);
    expect(form.type).toBe('form');
    expect(form.submitToolName).toBe('post_expense');
    expect(form.title).toBe('Create an expense');

    const byName = Object.fromEntries(form.fields.map((f) => [f.name, f]));

    expect(byName.amount).toEqual({
      name: 'amount',
      label: 'Amount',
      kind: 'number',
      required: true,
    });
    expect(byName.id).toEqual({
      name: 'id',
      label: 'Id',
      kind: 'string',
      required: true,
      format: 'uuid',
    });
    expect(byName.currency).toEqual({
      name: 'currency',
      label: 'Currency',
      kind: 'enum',
      required: false,
      enum: ['USD', 'EUR', 'GBP'],
    });
    expect(byName.approved).toEqual({
      name: 'approved',
      label: 'Approved',
      kind: 'boolean',
      required: false,
    });
  });

  it('produces a pure data descriptor (no functions anywhere)', () => {
    const form: UiComponent = toolInputForm(tool);
    assertNoFunctions(form);
  });

  it('handles an empty-property schema (no fields)', () => {
    const empty: AegisTool = {
      ...tool,
      name: 'ping',
      inputSchema: { type: 'object', properties: {} },
    };
    const form = toolInputForm(empty);
    expect(form.fields).toEqual([]);
    expect(form.submitToolName).toBe('ping');
  });
});
