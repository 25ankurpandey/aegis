import 'reflect-metadata';
import express from 'express';
import {
  assertPepBeforeRoutes,
  findUnguardedRoutes,
  markAuthGuard,
} from '../../src/bootstrap/pep-assertion';

const guard = markAuthGuard((_req, _res, next) => next());
const noop = (_req: express.Request, _res: express.Response): void => undefined;

describe('PEP-before-routes assertion (W2-14)', () => {
  it('flags a non-public route with no auth guard', () => {
    const app = express();
    app.get('/widgets', noop);
    const unguarded = findUnguardedRoutes(app);
    expect(unguarded).toEqual(['GET /widgets']);
  });

  it('passes a route that carries a tagged auth guard', () => {
    const app = express();
    app.get('/widgets', guard, noop);
    expect(findUnguardedRoutes(app)).toEqual([]);
  });

  it('treats /health (and other public prefixes) as public — no guard required', () => {
    const app = express();
    app.get('/health', noop);
    app.get('/api-docs', noop);
    app.get('/.well-known/jwks.json', noop);
    expect(findUnguardedRoutes(app)).toEqual([]);
  });

  it('ignores the framework terminal wildcard fallback', () => {
    const app = express();
    app.all('*', noop);
    expect(findUnguardedRoutes(app)).toEqual([]);
  });

  it('THROWS fail-closed at boot when an unguarded non-public route exists', () => {
    const app = express();
    app.post('/transfer', noop); // forgot the guard!
    expect(() => assertPepBeforeRoutes(app)).toThrow(/PEP assertion failed/);
    expect(() => assertPepBeforeRoutes(app)).toThrow(/POST \/transfer/);
  });

  it('does NOT throw when every non-public route is guarded', () => {
    const app = express();
    app.get('/health', noop);
    app.get('/widgets', guard, noop);
    app.post('/widgets', guard, noop);
    expect(() => assertPepBeforeRoutes(app)).not.toThrow();
  });

  it('collectOnly returns the offenders instead of throwing', () => {
    const app = express();
    app.get('/a', noop);
    app.get('/b', guard, noop);
    expect(assertPepBeforeRoutes(app, { collectOnly: true })).toEqual(['GET /a']);
  });

  it('honors a custom publicPaths allowlist', () => {
    const app = express();
    app.get('/metrics', noop);
    expect(findUnguardedRoutes(app, { publicPaths: ['/metrics'] })).toEqual([]);
  });

  it('markAuthGuard returns the same handler reference (composable)', () => {
    const h = (_req: express.Request, _res: express.Response, next: express.NextFunction): void => next();
    expect(markAuthGuard(h)).toBe(h);
  });
});
