import type { RequestHandler } from 'express';
import type Joi from 'joi';

/**
 * Route metadata stamps — the seam that makes the platform self-describing to agents.
 *
 * The Express router walk (see {@link findUnguardedRoutes}) can see a route's method + path, but the
 * *permission* it requires and the *input schema* it validates are captured inside the closures of
 * `authorize(Permission.X)` and `validate(schema)` — invisible to a walk. These helpers stamp that
 * information onto the returned handler (exactly the way {@link markAuthGuard} tags a guard), so a
 * later walk can recover it and auto-generate an authz-bound tool registry from running code — no
 * hand-maintained tool list, and any new route becomes an agent tool by construction.
 *
 * Kept in service-core (alongside `markAuthGuard`) so both the PEP (access-control) and the `validate`
 * middleware can stamp without a library cycle, and `@aegis/ai-core` can read the stamps.
 */

export const PERMISSIONS_MARKER = '__aegisPermissions' as const;
export const SCHEMA_MARKER = '__aegisSchema' as const;
export const SCHEMA_SOURCE_MARKER = '__aegisSchemaSource' as const;

type PermTaggable = RequestHandler & { [PERMISSIONS_MARKER]?: string[] };
type SchemaTaggable = RequestHandler & {
  [SCHEMA_MARKER]?: Joi.ObjectSchema;
  [SCHEMA_SOURCE_MARKER]?: string;
};

/** Stamp the permission(s) a route requires onto its authorize guard. Returns the handler. */
export function markPermissions<T extends RequestHandler>(handler: T, permissions: string[]): T {
  (handler as PermTaggable)[PERMISSIONS_MARKER] = permissions;
  return handler;
}

/** Recover the permissions stamped on a handler (or undefined if none). */
export function readPermissions(handle: unknown): string[] | undefined {
  return typeof handle === 'function' ? (handle as PermTaggable)[PERMISSIONS_MARKER] : undefined;
}

/** Stamp the Joi input schema (and which request part it validates) onto a validate handler. */
export function markSchema<T extends RequestHandler>(
  handler: T,
  schema: Joi.ObjectSchema,
  source: string,
): T {
  (handler as SchemaTaggable)[SCHEMA_MARKER] = schema;
  (handler as SchemaTaggable)[SCHEMA_SOURCE_MARKER] = source;
  return handler;
}

/** Recover the input schema + source stamped on a handler (or undefined if none). */
export function readSchema(
  handle: unknown,
): { schema: Joi.ObjectSchema; source: string } | undefined {
  if (typeof handle !== 'function') return undefined;
  const h = handle as SchemaTaggable;
  const schema = h[SCHEMA_MARKER];
  if (!schema) return undefined;
  return { schema, source: h[SCHEMA_SOURCE_MARKER] ?? 'body' };
}
