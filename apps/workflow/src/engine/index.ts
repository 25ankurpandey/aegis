import { registerBuiltinValidators } from './validators/builtin';
import { registerBuiltinActions } from './actions/builtin';

export * from './types';
export * from './operators';
export * from './evaluate-step';
export * from './aggregate';
export { registerValidator, getValidator, hasValidator, registeredFields } from './validators/registry';
export { registerAction, getActionHandler, hasActionHandler, registeredActionTypes } from './actions/registry';

let bootstrapped = false;

/** Register the built-in validators + action handlers once at service bootstrap. Idempotent. */
export function registerBuiltinEngine(): void {
  if (bootstrapped) return;
  registerBuiltinValidators();
  registerBuiltinActions();
  bootstrapped = true;
}
