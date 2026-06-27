import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { type Express, type Request, type Response } from 'express';
import swaggerUi from 'swagger-ui-express';
import { load as parseYaml } from 'js-yaml';
import { Logger } from '@aegis/service-core';

/**
 * Public, interactive API reference (Swagger UI) served at the gateway edge.
 *
 * This is mounted BEFORE the core middleware band (`applyCoreMiddleware`) so it stays public — it
 * never hits the PEP/auth wall. (`/api-docs` is also in service-core's `DEFAULT_PUBLIC_PATHS`, but
 * the gateway is plain proxy + middleware, so mounting first is what actually keeps it open.)
 *
 * The spec is the regenerated `docs/api/openapi.yaml` (covers every route). In the built image the
 * repo tree is gone, so the webpack build copies the spec next to the bundle (Nx `assets`); we load
 * it from a path resolved relative to the bundle at runtime. ts-node/dev resolves it from the repo
 * tree. The bundled server uses `http://localhost:4000` as the spec server.
 */

/** Server URL advertised in the live spec (the gateway edge). */
const GATEWAY_SERVER_URL = 'http://localhost:4000';

/**
 * Candidate locations for the spec, in priority order:
 *  1. next to the bundle (`dist/apps/gateway/openapi.yaml`) — copied by webpack `assets` at build;
 *     `__dirname` is the bundle dir in the built image.
 *  2. the repo source under dev/ts-node (`<repo>/docs/api/openapi.yaml`).
 */
function candidateSpecPaths(): string[] {
  return [
    join(__dirname, 'openapi.yaml'),
    join(__dirname, '..', '..', '..', 'docs', 'api', 'openapi.yaml'),
    join(process.cwd(), 'docs', 'api', 'openapi.yaml'),
  ];
}

/** A minimal spec object so the UI degrades gracefully if the spec file is somehow absent. */
function fallbackSpec(): Record<string, unknown> {
  return {
    openapi: '3.0.3',
    info: { title: 'Aegis API', version: '1.0.0', description: 'OpenAPI spec not found at runtime.' },
    servers: [{ url: GATEWAY_SERVER_URL }],
    paths: {},
  };
}

/** Load + parse the OpenAPI spec from the first candidate path that exists. */
function loadSpec(): Record<string, unknown> {
  for (const path of candidateSpecPaths()) {
    if (!existsSync(path)) continue;
    try {
      const parsed = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
      // Pin the advertised server to the gateway edge so "Try it out" targets the right host.
      parsed.servers = [{ url: GATEWAY_SERVER_URL, description: 'Gateway (edge)' }];
      Logger.info(`api-docs: loaded OpenAPI spec from ${path}`);
      return parsed;
    } catch (err) {
      Logger.error(err as Error, 'API_DOCS_SPEC_PARSE', 'gateway', { path });
    }
  }
  Logger.warn('api-docs: OpenAPI spec not found; serving fallback', {
    tried: candidateSpecPaths(),
  });
  return fallbackSpec();
}

/**
 * Mount the public docs routes on the gateway app. MUST be called before `applyCoreMiddleware`.
 *  - `GET /api-docs`      → interactive Swagger UI (Bearer JWT "Authorize" button, persisted).
 *  - `GET /api-docs.json` → the raw parsed spec, for tooling/codegen.
 */
export function mountApiDocs(app: Express): void {
  const spec = loadSpec();

  app.get('/api-docs.json', (_req: Request, res: Response) => res.json(spec));

  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      explorer: true,
      customSiteTitle: 'Aegis API — live reference',
      swaggerOptions: { persistAuthorization: true },
    }),
  );
}
