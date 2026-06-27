import { RequestContext, type RequestContextData } from '@aegis/service-core';
import type { AccessShape } from '@aegis/shared-types';
import { SystemRole } from '@aegis/shared-enums';

/** @aegis/testing — shared test helpers: context stubs, principal/PDP fixtures. */

export const TEST_TENANT = '00000000-0000-4000-8000-0000000000aa';
export const TEST_USER = '00000000-0000-4000-8000-0000000000bb';

/** Run `fn` inside a seeded RequestContext scope (defaults to a test tenant + user). */
export function runInContext<T>(fn: () => T, over: Partial<RequestContextData> = {}): T {
  return RequestContext.run(
    { tenantId: TEST_TENANT, userId: TEST_USER, correlationId: 'test-correlation', startedAt: Date.now(), ...over },
    fn,
  );
}

/** Build a PDP principal fixture. */
export function makePrincipal(over: Partial<AccessShape.Principal> = {}): AccessShape.Principal {
  return { userId: TEST_USER, tenantId: TEST_TENANT, roles: [SystemRole.Admin], permissions: [], ...over };
}

/** Build a PDP resource-ref fixture. */
export function makeResource(over: Partial<AccessShape.ResourceRef> = {}): AccessShape.ResourceRef {
  return { type: 'record', tenantId: TEST_TENANT, ...over };
}
