import type { Request, Response } from 'express';
import { errorMiddleware } from '../../src/middleware/error.middleware';
import { ErrUtils, ErrorType, AppError } from '../../src/errors/error-utils';
import { RequestContext } from '../../src/context/request-context';
import type { RequestContextData } from '../../src/context/context.types';
import { Logger } from '../../src/logging/logger';

const CORR = 'corr-err-1';
const TENANT = '11111111-1111-4111-8111-111111111111';

function ctx(): RequestContextData {
  return { tenantId: TENANT, correlationId: CORR, startedAt: Date.now() };
}

/** Minimal Express `res` double capturing the status + serialised JSON envelope. */
function mockRes(): Response & { _status: number; _json: any } {
  const res = {
    _status: 0,
    _json: undefined as any,
    status(code: number) {
      this._status = code;
      return this;
    },
    json(body: any) {
      this._json = body;
      return this;
    },
  };
  return res as unknown as Response & { _status: number; _json: any };
}

/** Drive the terminal handler with a thrown value inside an open request-context scope. */
function handle(err: unknown): { status: number; envelope: any } {
  return RequestContext.run(ctx(), () => {
    const res = mockRes();
    errorMiddleware(err, {} as Request, res, () => undefined);
    return { status: (res as any)._status, envelope: (res as any)._json };
  });
}

describe('errorMiddleware — info-leak guard (W1-12)', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    // Silence + capture server-side logging.
    errorSpy = jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('keeps the envelope shape (code/type/message/correlationId) stable', () => {
    const { status, envelope } = handle(ErrUtils.forbidden('nope'));
    expect(status).toBe(403);
    expect(envelope).toEqual({
      errors: [
        expect.objectContaining({
          code: 'E_FORBIDDEN',
          type: 'FORBIDDEN',
          message: 'nope',
          correlationId: CORR,
        }),
      ],
    });
  });

  it('preserves operational 4xx AppError messages (safe to expose)', () => {
    for (const factory of [
      () => ErrUtils.validation('Email is required'),
      () => ErrUtils.unauthorized('Token expired'),
      () => ErrUtils.notFound('Report 42 not found'),
      () => ErrUtils.conflict('Invoice already approved'),
    ]) {
      const err = factory();
      const { status, envelope } = handle(err);
      expect(status).toBe(err.status);
      expect(status).toBeLessThan(500);
      expect(envelope.errors[0].message).toBe(err.message);
    }
  });

  it('preserves 4xx details (field-level info is safe once sanitised upstream)', () => {
    const details = [{ message: 'must be a number', path: ['amount'], type: 'number.base' }];
    const { envelope } = handle(ErrUtils.validation('Validation error', details));
    expect(envelope.errors[0].details).toEqual(details);
  });

  it('masks the raw message for an unexpected (non-AppError) throw with a generic message', () => {
    const { status, envelope } = handle(new Error('ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    expect(status).toBe(500);
    const item = envelope.errors[0];
    expect(item.type).toBe('SYSTEM');
    expect(item.code).toBe('E_SYSTEM');
    expect(item.message).toBe('Internal server error');
    // The leaky internals must NOT reach the client.
    expect(item.message).not.toContain('ECONNREFUSED');
    expect(item.message).not.toContain('hunter2');
    expect(item.details).toBeUndefined();
    expect(item.correlationId).toBe(CORR);
  });

  it('masks the message AND drops details for a System AppError (5xx)', () => {
    const leaky = ErrUtils.system('internal pointer 0xdeadbeef', { query: 'SELECT secret FROM vault' });
    const { status, envelope } = handle(leaky);
    expect(status).toBe(500);
    expect(envelope.errors[0].message).toBe('Internal server error');
    expect(envelope.errors[0].message).not.toContain('0xdeadbeef');
    expect(envelope.errors[0].details).toBeUndefined();
  });

  it('masks the message AND drops details for a Database AppError (5xx)', () => {
    const leaky = ErrUtils.database('duplicate key value violates unique constraint "users_email_key"', {
      table: 'users',
    });
    const { status, envelope } = handle(leaky);
    expect(status).toBe(500);
    expect(envelope.errors[0].type).toBe('DATABASE');
    expect(envelope.errors[0].message).toBe('Internal server error');
    expect(envelope.errors[0].message).not.toContain('users_email_key');
    expect(envelope.errors[0].details).toBeUndefined();
  });

  it('still logs the FULL original error server-side (message, details, correlationId) for 5xx', () => {
    const original = new Error('ECONNREFUSED 10.0.0.5:5432 password=hunter2');
    handle(original);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [loggedErr, errId, errType, data] = errorSpy.mock.calls[0];
    // The ORIGINAL throw is logged (real stack/message survives), not the sanitised copy.
    expect(loggedErr).toBe(original);
    expect(errId).toBe('E_SYSTEM');
    expect(errType).toBe('SYSTEM');
    expect((data as any).status).toBe(500);
  });

  it('logs the unredacted details server-side for a 5xx AppError even though they are withheld from the client', () => {
    const secretDetails = { query: 'SELECT secret FROM vault' };
    handle(new AppError(ErrorType.Database, 'pg error', secretDetails));
    const [, , , data] = errorSpy.mock.calls[0];
    expect((data as any).details).toEqual(secretDetails);
  });
});
