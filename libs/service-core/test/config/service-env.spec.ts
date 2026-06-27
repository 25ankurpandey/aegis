import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadServiceEnv } from '../../src/config/service-env';

const savedEnv = { ...process.env };
let tempDirs: string[] = [];

afterEach(() => {
  process.env = { ...savedEnv };
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-env-'));
  tempDirs.push(dir);
  return dir;
}

describe('loadServiceEnv', () => {
  it('loads apps/<service>/.env for direct local service runs without overriding shell env', () => {
    const repo = makeTempRepo();
    const envDir = path.join(repo, 'apps', 'expense');
    fs.mkdirSync(envDir, { recursive: true });
    fs.writeFileSync(path.join(envDir, '.env'), 'PORT=4999\nDATABASE_URL=from-file\n', 'utf8');
    process.env.PORT = '4002';

    const result = loadServiceEnv('expense', repo);

    expect(result.loadedPath).toBe(path.join(envDir, '.env'));
    expect(process.env.PORT).toBe('4002');
    expect(process.env.DATABASE_URL).toBe('from-file');
  });

  it('prefers AEGIS_ENV_FILE when an explicit path is provided', () => {
    const repo = makeTempRepo();
    const explicit = path.join(repo, 'local.env');
    fs.writeFileSync(explicit, 'SERVICE_NAME=custom\n', 'utf8');
    process.env.AEGIS_ENV_FILE = explicit;

    const result = loadServiceEnv('gateway', repo);

    expect(result.loadedPath).toBe(explicit);
    expect(process.env.SERVICE_NAME).toBe('custom');
  });
});
