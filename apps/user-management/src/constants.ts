import { ApiConstants } from '@aegis/shared-constants';

/**
 * Public (unauthenticated) routes for this service's fail-closed PEP assertion. Passing
 * `publicPaths` to `assertPep` REPLACES the built-in infra allowlist, so the infra prefixes
 * (`/health`, `/api-docs`, `/.well-known`, `/favicon.ico`) are re-listed here alongside this IdP's
 * two legitimately-public endpoints (register/login). Every OTHER route keeps its
 * `authenticate()`/`authorize()` guard.
 *
 * Service-local composition-root wiring (this service's own PEP allowlist), not a cross-service
 * domain constant — see docs/analysis/CONSTANTS_AUDIT.md.
 */
export const PUBLIC_PATHS = [
  '/health',
  '/api-docs',
  '/.well-known',
  '/favicon.ico',
  `/user-management${ApiConstants.PublicPrefix}/auth/register`,
  `/user-management${ApiConstants.PublicPrefix}/auth/login`,
];
