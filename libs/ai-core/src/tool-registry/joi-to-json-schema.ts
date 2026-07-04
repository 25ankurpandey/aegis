import type Joi from 'joi';
import type { JsonSchema } from './types';

/**
 * Convert a Joi schema to a JSON-Schema (Draft-07 subset) via Joi's own `.describe()` — dependency-free
 * (no `joi-to-json`, which is not in the repo). Handles the constructs the Aegis validators actually use:
 * object/array/string/number/boolean/date, presence(required), string length/min/max + uuid/guid/isoDate/
 * email/uri formats, number integer + min/max, and `.valid(...)` enums. Unknown constructs degrade to a
 * bare `{ type }` rather than throwing — a tool schema is best-effort context for the model, never a
 * security control (the governed `validate()` middleware remains the real gate at execution time).
 */
export function joiToJsonSchema(schema: Joi.ObjectSchema): JsonSchema {
  return describeToJsonSchema(schema.describe());
}

interface JoiDesc {
  type?: string;
  keys?: Record<string, JoiDesc>;
  items?: JoiDesc[];
  flags?: { presence?: string; only?: boolean; default?: unknown; description?: string };
  rules?: Array<{ name: string; args?: Record<string, unknown> }>;
  allow?: unknown[];
}

export function describeToJsonSchema(descIn: unknown): JsonSchema {
  const desc = (descIn ?? {}) as JoiDesc;
  let out: JsonSchema;
  switch (desc.type) {
    case 'object':
      out = convertObject(desc);
      break;
    case 'array':
      out = { type: 'array', items: desc.items?.[0] ? describeToJsonSchema(desc.items[0]) : {} };
      break;
    case 'number':
      out = convertNumber(desc);
      break;
    case 'string':
      out = convertString(desc);
      break;
    case 'boolean':
      out = { type: 'boolean' };
      break;
    case 'date':
      out = { type: 'string', format: 'date-time' };
      break;
    default:
      out = desc.type ? { type: desc.type } : {};
  }
  // `.valid(a, b)` → enum (Joi marks `flags.only` and lists values in `allow`).
  if (desc.flags?.only && Array.isArray(desc.allow) && desc.allow.length > 0) {
    out.enum = desc.allow;
  }
  if (desc.flags?.default !== undefined) out.default = desc.flags.default;
  if (desc.flags?.description) out.description = desc.flags.description;
  return out;
}

function convertObject(desc: JoiDesc): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(desc.keys ?? {})) {
    properties[key] = describeToJsonSchema(child);
    if (child.flags?.presence === 'required') required.push(key);
  }
  const out: JsonSchema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) out.required = required;
  return out;
}

function convertNumber(desc: JoiDesc): JsonSchema {
  const rules = desc.rules ?? [];
  const out: JsonSchema = { type: rules.some((r) => r.name === 'integer') ? 'integer' : 'number' };
  for (const r of rules) {
    if (r.name === 'min') out.minimum = num(r.args?.limit);
    if (r.name === 'max') out.maximum = num(r.args?.limit);
    if (r.name === 'greater') out.minimum = num(r.args?.limit);
    if (r.name === 'less') out.maximum = num(r.args?.limit);
  }
  return out;
}

function convertString(desc: JoiDesc): JsonSchema {
  const rules = desc.rules ?? [];
  const out: JsonSchema = { type: 'string' };
  for (const r of rules) {
    switch (r.name) {
      case 'length':
        out.minLength = num(r.args?.limit);
        out.maxLength = num(r.args?.limit);
        break;
      case 'min':
        out.minLength = num(r.args?.limit);
        break;
      case 'max':
        out.maxLength = num(r.args?.limit);
        break;
      case 'guid':
      case 'uuid':
        out.format = 'uuid';
        break;
      case 'isoDate':
        out.format = 'date-time';
        break;
      case 'email':
        out.format = 'email';
        break;
      case 'uri':
        out.format = 'uri';
        break;
      default:
        break;
    }
  }
  return out;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
