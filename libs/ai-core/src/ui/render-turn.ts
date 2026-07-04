import type { AegisTurnResult } from '../orchestrator/agent-orchestrator';
import type { AegisTool, JsonSchema } from '../tool-registry/types';
import type {
  UiComponent,
  UiField,
  UiForm,
} from './ui-spec';

/**
 * @aegis/ai-core / ui — RENDER a governed turn to a GENERATIVE UI descriptor (A2UI-shaped).
 *
 * Pure and DETERMINISTIC: an {@link AegisTurnResult} maps to exactly one {@link UiComponent}, with no
 * I/O and no functions in the output (the UI-as-data invariant). The mapping mirrors the turn union:
 *   - message        → UiText,
 *   - tool (ok)      → UiTable / UiKeyValue of a SAFE stringification of the body,
 *   - tool (!ok)     → UiAlert (danger) carrying the status,
 *   - refused        → UiAlert (warning) carrying the reason,
 *   - needs_ceremony → UiApprovalCard populated from the server-computed danger decision.
 *
 * The renderer that draws these descriptors is separate and untrusted; this module only produces data.
 */

/** JSON-safe scalar → string. Objects/arrays are compactly JSON-stringified (never a function). */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** True iff `body` is a homogeneous array of flat objects — the shape that renders well as a table. */
function isRowArray(body: unknown): body is Record<string, unknown>[] {
  return (
    Array.isArray(body) &&
    body.length > 0 &&
    body.every(
      (row) => typeof row === 'object' && row !== null && !Array.isArray(row),
    )
  );
}

/**
 * Render a successful tool body. An array of objects becomes a UiTable (union of keys as columns);
 * anything else becomes a UiKeyValue of its top-level entries (or a single `result` row for a scalar).
 */
function renderToolBody(body: unknown): UiComponent {
  if (isRowArray(body)) {
    const columns: string[] = [];
    for (const row of body) {
      for (const key of Object.keys(row)) {
        if (!columns.includes(key)) columns.push(key);
      }
    }
    const rows = body.map((row) => columns.map((col) => stringifyValue(row[col])));
    return { type: 'table', columns, rows };
  }

  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const pairs = Object.entries(body as Record<string, unknown>).map(([label, value]) => ({
      label,
      value: stringifyValue(value),
    }));
    return { type: 'keyValue', pairs };
  }

  return { type: 'keyValue', pairs: [{ label: 'result', value: stringifyValue(body) }] };
}

/**
 * Map one governed turn to a single generative-UI descriptor. Deterministic and pure; the output holds
 * only data (no functions), so it is safe to serialize and hand to an untrusted renderer.
 */
export function renderTurn(turn: AegisTurnResult): UiComponent {
  switch (turn.kind) {
    case 'message':
      return { type: 'text', text: turn.text };

    case 'tool':
      if (turn.result.ok) return renderToolBody(turn.result.body);
      return {
        type: 'alert',
        tone: 'danger',
        text: `Tool "${turn.toolName}" failed (status ${turn.result.status}).`,
      };

    case 'refused':
      return { type: 'alert', tone: 'warning', text: turn.reason };

    case 'needs_ceremony': {
      const { decision, toolName, args } = turn;
      const summary = `${turn.tool.method} ${turn.tool.path} — args ${stringifyValue(args)}`;
      return {
        type: 'approvalCard',
        title: `Confirmation required: ${toolName}`,
        summary,
        danger: {
          ceremony: decision.ceremony,
          level: decision.level,
          reasons: decision.reasons,
          ...(decision.typedConfirmationPhrase
            ? { typedConfirmationPhrase: decision.typedConfirmationPhrase }
            : {}),
        },
        actions: ['confirm', 'cancel'],
      };
    }
  }
}

/** Map a JSON Schema property to the form-field `kind`; unknown/compound types fall back to string. */
function fieldKind(prop: JsonSchema): UiField['kind'] {
  if (prop.enum && prop.enum.length > 0) return 'enum';
  switch (prop.type) {
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

/** Prettify a schema property name into a field label (e.g. `amountMinor` → `Amount Minor`). */
function humanizeLabel(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Derive a {@link UiForm} from a tool's `inputSchema`: each schema property becomes a typed
 * {@link UiField} (required from `schema.required`, `enum`/`format` passed through), and
 * `submitToolName` is the tool's name. Deterministic and pure — no functions in the output.
 */
export function toolInputForm(tool: AegisTool): UiForm {
  const schema = tool.inputSchema;
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const fields: UiField[] = Object.entries(properties).map(([name, prop]) => {
    const kind = fieldKind(prop);
    const field: UiField = {
      name,
      label: humanizeLabel(name),
      kind,
      required: required.has(name),
    };
    if (prop.format) field.format = prop.format;
    if (kind === 'enum' && prop.enum) {
      field.enum = prop.enum.map((v) => stringifyValue(v));
    }
    return field;
  });

  return {
    type: 'form',
    title: tool.description,
    fields,
    submitToolName: tool.name,
  };
}
