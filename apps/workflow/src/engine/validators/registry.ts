import { ErrUtils } from '@aegis/service-core';
import type { FieldValidator } from '../types';

/**
 * Field → validator registry. A new condition type is one more registered function — the engine
 * core never changes. Registration is idempotent per field.
 */
const validators = new Map<string, FieldValidator>();

export function registerValidator(field: string, fn: FieldValidator): void {
  validators.set(field, fn);
}

export function getValidator(field: string): FieldValidator {
  const fn = validators.get(field);
  if (!fn) throw ErrUtils.validation(`Unknown condition field '${field}'`);
  return fn;
}

export function hasValidator(field: string): boolean {
  return validators.has(field);
}

export function registeredFields(): string[] {
  return [...validators.keys()];
}
