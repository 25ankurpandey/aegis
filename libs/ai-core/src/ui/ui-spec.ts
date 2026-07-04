import type { Ceremony, DangerLevel } from '../danger/types';

/**
 * @aegis/ai-core / ui — GENERATIVE UI descriptors (A2UI-shaped, UI-as-data).
 *
 * The agent reasons; the governed core acts; and when a turn needs to reach a human, it does so as
 * DATA, never as code. Every value in this module is a plain JSON-serializable structure — no
 * functions, no handlers, no executable expressions. That is the load-bearing invariant: a descriptor
 * produced here is safe to hand to an UNTRUSTED renderer (a web canvas, a Unity surface, a mobile
 * shell) which decides how to draw it. The renderer is separate and out of scope; this module only
 * describes WHAT to show, never HOW, and never runs anything.
 *
 * Actions (e.g. a form's `submitToolName`, an approval card's `actions`) are carried as STRING
 * references — a tool name, a verb label — that the host resolves back to a governed route. The UI
 * never embeds the callable itself; the guarded route (authenticate → authorize → validate → RLS →
 * audit) remains the only path to a mutation.
 */

/** A plain run of text. */
export interface UiText {
  type: 'text';
  text: string;
}

/** A small status pill. `tone` maps to a renderer-defined colour/semantics. */
export interface UiBadge {
  type: 'badge';
  label: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

/** An ordered list of label/value rows (both stringified — UI-as-data). */
export interface UiKeyValue {
  type: 'keyValue';
  pairs: { label: string; value: string }[];
}

/** A simple tabular grid; every cell is a string (safe stringification upstream). */
export interface UiTable {
  type: 'table';
  columns: string[];
  rows: string[][];
}

/** One field of a {@link UiForm}, derived from a tool's JSON Schema property. */
export interface UiField {
  name: string;
  label: string;
  kind: 'string' | 'number' | 'boolean' | 'enum';
  required: boolean;
  /** Passthrough JSON Schema `format` hint (e.g. `uuid`, `date-time`) for the renderer. */
  format?: string;
  /** Passthrough allowed values when `kind` is `enum`. */
  enum?: string[];
}

/** A data-driven form. `submitToolName` is a STRING reference the host resolves to a governed route. */
export interface UiForm {
  type: 'form';
  title?: string;
  fields: UiField[];
  submitToolName?: string;
}

/**
 * The human ceremony surface for a danger-gated action. It carries the SERVER-computed danger decision
 * (ceremony / level / reasons / typed phrase) verbatim so the approver acts on validated facts, never
 * on the model's paraphrase. `actions` are string labels (e.g. `confirm`, `cancel`) the host wires.
 */
export interface UiApprovalCard {
  type: 'approvalCard';
  title: string;
  summary: string;
  danger: {
    ceremony: Ceremony;
    level: DangerLevel;
    reasons: string[];
    typedConfirmationPhrase?: string;
  };
  actions: string[];
}

/** A prominent inline banner. */
export interface UiAlert {
  type: 'alert';
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  text: string;
}

/**
 * The GENERATIVE UI descriptor union — a closed, all-data set of components a turn can render to. Every
 * member is a discriminated variant keyed on `type`; nothing here holds a function (the UI-as-data
 * invariant that keeps descriptors safe for untrusted rendering).
 */
export type UiComponent =
  | UiText
  | UiBadge
  | UiKeyValue
  | UiTable
  | UiForm
  | UiApprovalCard
  | UiAlert;
