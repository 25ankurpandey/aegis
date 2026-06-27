/**
 * Live E2E client — a thin fetch wrapper that drives the running Aegis stack through the GATEWAY
 * (the single public entry point), exactly as an external caller would.
 *
 * The whole live suite is GATED on `E2E_BASE_URL`. When it is unset (the normal mocked `npx jest`
 * run), `describeE2E` collapses to `describe.skip` so NO test body executes and NO network call is
 * ever made — the suite is inert under unit-test mode. Point `E2E_BASE_URL` at the gateway
 * (e.g. `http://localhost:4000`) after `bash scripts/dev-up.sh` to actually run it.
 *
 * Seeded fixtures (from apps/cli/src/seeders):
 *   Tenant A: 00000000-0000-4000-8000-000000000001  admin@demo-org.test   / demo-admin-pw
 *   Tenant B: 00000000-0000-4000-8000-000000000002  admin@demo-org-b.test / demo-admin-pw-b
 */

// Minimal structural types so this file tsc-compiles without depending on the DOM lib. The running
// Node (>=18) provides the real global `fetch`; we only need the shapes we actually touch.
type FetchHeaders = Record<string, string>;
interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
type FetchFn = (url: string, init?: { method?: string; headers?: FetchHeaders; body?: string }) => Promise<FetchResponse>;
declare const fetch: FetchFn;

/** Seeded tenant + credential fixtures, kept in one place so every spec agrees on them. */
export const FIXTURES = {
  tenantA: {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'admin@demo-org.test',
    password: 'demo-admin-pw',
  },
  tenantB: {
    id: '00000000-0000-4000-8000-000000000002',
    email: 'admin@demo-org-b.test',
    password: 'demo-admin-pw-b',
  },
} as const;

/** Header keys the platform requires on every request (see libs/shared/enums/http-header-key.enum.ts). */
const HEADER = {
  tenantId: 'x-tenant-id',
  correlationId: 'x-correlation-id',
  authorization: 'authorization',
} as const;

export const E2E_BASE_URL = (process.env['E2E_BASE_URL'] ?? '').replace(/\/+$/, '');
export const e2eEnabled = E2E_BASE_URL.length > 0;

/**
 * `describe` that is SKIPPED unless `E2E_BASE_URL` is set. Use this for every live block so the suite
 * is collected (and visible) under a normal `npx jest`, but never executes a body / opens a socket.
 */
export const describeE2E: jest.Describe = (e2eEnabled ? describe : describe.skip) as jest.Describe;

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
  raw: string;
  correlationId: string | null;
}

export interface RequestOpts {
  method?: string;
  tenantId: string;
  token?: string;
  body?: unknown;
  /** Extra raw headers (e.g. Idempotency-Key). */
  headers?: FetchHeaders;
  /** Override the correlation id (defaults to a generated one). */
  correlationId?: string;
}

let counter = 0;
function newCorrelationId(): string {
  counter += 1;
  return `e2e-${Date.now().toString(36)}-${counter}`;
}

/**
 * Issue a request to the gateway. Always sends the required `x-tenant-id` + `x-correlation-id`
 * context headers; attaches `Authorization: Bearer <token>` when a token is supplied. Returns the
 * parsed JSON body (or the raw text when the response is not JSON) plus the status + correlation id.
 */
export async function api<T = unknown>(path: string, opts: RequestOpts): Promise<ApiResult<T>> {
  const correlationId = opts.correlationId ?? newCorrelationId();
  const headers: FetchHeaders = {
    'content-type': 'application/json',
    [HEADER.tenantId]: opts.tenantId,
    [HEADER.correlationId]: correlationId,
    ...(opts.headers ?? {}),
  };
  if (opts.token) headers[HEADER.authorization] = `Bearer ${opts.token}`;

  const res = await fetch(`${E2E_BASE_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const raw = await res.text();
  let body: T;
  try {
    body = raw ? (JSON.parse(raw) as T) : (undefined as T);
  } catch {
    body = raw as unknown as T;
  }
  return { status: res.status, body, raw, correlationId: res.headers.get(HEADER.correlationId) };
}

interface LoginResponse {
  token: string;
  expiresIn: number;
  user: { id: string; email: string; roles: string[] };
}

/** Log in a seeded admin through the gateway and return the bearer token + user id. */
export async function login(tenant: { id: string; email: string; password: string }): Promise<{ token: string; userId: string }> {
  const res = await api<LoginResponse>('/user-management/v1/auth/login', {
    method: 'POST',
    tenantId: tenant.id,
    body: { email: tenant.email, password: tenant.password },
  });
  if (res.status !== 200 || !res.body?.token) {
    throw new Error(`login failed for ${tenant.email} (status ${res.status}): ${res.raw}`);
  }
  return { token: res.body.token, userId: res.body.user.id };
}

/** A unique-ish suffix for created records so reruns don't collide on natural keys. */
export function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}
