import 'reflect-metadata';
import express, { type Express } from 'express';
import Joi from 'joi';
import { validate, sanitizeValidationDetails } from '../../src/middleware/validation.middleware';
import { errorMiddleware } from '../../src/middleware/error.middleware';
import { RequestContext } from '../../src/context/request-context';
import type { RequestContextData } from '../../src/context/context.types';
import { inject } from '../helpers/inject';

/** POST JSON against the Express app in memory; no port binding needed for middleware tests. */
async function listen(app: Express): Promise<{
  post: (path: string, body: unknown) => Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}> {
  return {
    async post(path, body) {
      const res = await inject(app, { method: 'POST', path, headers: { 'content-type': 'application/json' }, body });
      return { status: res.status, body: res.body };
    },
    close: async () => undefined,
  };
}

const CORR = 'corr-val-1';
const TENANT = '11111111-1111-4111-8111-111111111111';

function seed(): RequestContextData {
  return { tenantId: TENANT, correlationId: CORR, startedAt: Date.now() };
}

/** Produce a real Joi ValidationError (abortEarly off, mirroring the middleware options). */
async function joiError(schema: Joi.ObjectSchema, payload: unknown): Promise<Joi.ValidationError> {
  try {
    await schema.validateAsync(payload, { abortEarly: false, stripUnknown: true });
  } catch (err) {
    return err as Joi.ValidationError;
  }
  throw new Error('expected validation to fail');
}

describe('sanitizeValidationDetails — does not echo the offending value (W1-12)', () => {
  it('keeps message/path/type but strips context.value (the input echo)', async () => {
    const schema = Joi.object({ email: Joi.string().email().required() });
    const err = await joiError(schema, { email: 'attacker<script>@evil' });

    // Raw Joi carries the offending input on every detail; assert that is what we are stripping.
    expect(err.details[0].context?.value).toBe('attacker<script>@evil');

    const safe = sanitizeValidationDetails(err);
    expect(safe).toHaveLength(1);
    expect(safe[0]).toMatchObject({ path: ['email'], type: 'string.email' });
    expect(typeof safe[0].message).toBe('string');

    // The offending value must not survive anywhere in the serialised detail.
    const serialised = JSON.stringify(safe);
    expect(serialised).not.toContain('attacker');
    expect(serialised).not.toContain('<script>');
    // Defensive: no `value`/`context` keys at all.
    expect(Object.keys(safe[0])).not.toContain('value');
    expect(Object.keys(safe[0])).not.toContain('context');
  });

  it('reports every failing field at once and surfaces the constraint limit (not the value)', async () => {
    const schema = Joi.object({
      name: Joi.string().min(3).required(),
      age: Joi.number().required(),
    });
    const err = await joiError(schema, { name: 'ab', age: 'not-a-number' });

    const safe = sanitizeValidationDetails(err);
    const byField = Object.fromEntries(safe.map((d) => [String(d.path[0]), d]));

    expect(byField.name.type).toBe('string.min');
    expect(byField.name.limit).toBe(3); // structural bound is safe to expose
    expect(byField.age.type).toBe('number.base');

    // None of the offending inputs leak.
    const serialised = JSON.stringify(safe);
    expect(serialised).not.toContain('not-a-number');
    expect(serialised).not.toContain('"ab"');
  });
});

describe('validate() middleware — envelope omits the offending value end-to-end', () => {
  function buildApp(schema: Joi.ObjectSchema): Express {
    const app = express();
    app.use(express.json());
    // Open a request-context scope so the envelope carries a correlationId, like the real band.
    app.use((req, res, next) => RequestContext.run(seed(), () => next()));
    app.post('/things', validate(schema), (_req, res) => res.json({ ok: true }));
    app.use(errorMiddleware);
    return app;
  }

  it('returns 400 with field/constraint details but never the submitted value', async () => {
    const schema = Joi.object({ email: Joi.string().email().required() });
    const offending = 'super-secret-not-an-email';

    const http = await listen(buildApp(schema));
    try {
      const res = await http.post('/things', { email: offending });

      expect(res.status).toBe(400);
      expect(res.body.errors[0].type).toBe('VALIDATION');
      expect(res.body.errors[0].code).toBe('E_VALIDATION');
      expect(res.body.errors[0].correlationId).toBe(CORR);

      const details = res.body.errors[0].details;
      expect(Array.isArray(details)).toBe(true);
      expect(details[0]).toMatchObject({ path: ['email'], type: 'string.email' });

      // The whole serialised response must not contain the offending input.
      expect(JSON.stringify(res.body)).not.toContain(offending);
    } finally {
      await http.close();
    }
  });

  it('passes a valid payload through unchanged', async () => {
    const schema = Joi.object({ email: Joi.string().email().required() });
    const http = await listen(buildApp(schema));
    try {
      const res = await http.post('/things', { email: 'ok@example.com' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    } finally {
      await http.close();
    }
  });
});
