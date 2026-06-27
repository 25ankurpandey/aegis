import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export interface LoadServiceEnvResult {
  loadedPath?: string;
  attemptedPaths: string[];
}

/**
 * Load committed local env defaults for direct service runs.
 *
 * Docker Compose injects `apps/<service>/.env` via `env_file`, but plain local commands such as
 * `node -r ts-node/register ... apps/expense/src/index.ts` do not. This mirrors the donor entrypoint
 * pattern while keeping runtime env vars authoritative (`override: false`).
 */
export function loadServiceEnv(serviceName: string, cwd = process.cwd()): LoadServiceEnvResult {
  const explicit = process.env.AEGIS_ENV_FILE;
  const candidates = [
    ...(explicit ? [path.isAbsolute(explicit) ? explicit : path.resolve(cwd, explicit)] : []),
    path.resolve(cwd, 'apps', serviceName, '.env'),
    path.resolve(cwd, '.env'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    dotenv.config({ path: candidate, override: false });
    return { loadedPath: candidate, attemptedPaths: candidates };
  }

  return { attemptedPaths: candidates };
}
