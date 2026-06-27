import type { Request } from 'express';
import { ErrUtils } from '../errors/error-utils';

/** Extract one Express route param as a string, fail-closed if the route binding is malformed. */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  const first = Array.isArray(value) ? value[0] : value;
  if (!first || !first.trim()) {
    throw ErrUtils.validation(`Missing route parameter: ${name}`);
  }
  return first.trim();
}
