import type { RequestHandler } from 'express';
import type Joi from 'joi';
import { ErrUtils } from '../errors/error-utils';

/** Which part of the request a schema validates. */
export type ValidationSource = 'body' | 'query' | 'params';

/**
 * The client-safe shape of a single field validation failure. Carries enough for a caller to fix
 * their request — which field failed (`path`), the human message, the constraint kind (`type`, e.g.
 * `string.email`) and the bound that was violated (`limit`) — but deliberately NOT the offending
 * input the caller sent. Joi's raw `detail.context.value` echoes that input straight back, which
 * leaks request data into the error envelope (and can reflect injected payloads); we drop it.
 */
export interface SafeValidationDetail {
  message: string;
  path: Array<string | number>;
  type: string;
  /** The constraint bound, when the rule has one (e.g. `min`/`max`/`length` limit). Never the value. */
  limit?: unknown;
}

/**
 * Reduce raw Joi `ValidationError.details` to the client-safe `SafeValidationDetail[]`. Keeps
 * field/constraint info; strips `context.value` (and any other input echo) so the offending value is
 * never returned to the client. The full raw error is still logged server-side by the error handler.
 */
export function sanitizeValidationDetails(error: Joi.ValidationError): SafeValidationDetail[] {
  return error.details.map((detail) => {
    const safe: SafeValidationDetail = {
      message: detail.message,
      path: detail.path,
      type: detail.type,
    };
    // Surface only the numeric/structural bound (limit), never `context.value` / the raw input.
    const limit = (detail.context as { limit?: unknown } | undefined)?.limit;
    if (limit !== undefined) {
      safe.limit = limit;
    }
    return safe;
  });
}

/**
 * Schema-validation middleware (hoisted to the shared core): validate a request
 * segment against a Joi schema in the route decorator — e.g. `@httpPost('/login', validate(loginSchema))`
 * — instead of calling `validateAsync` inside handler bodies. On success the coerced/defaulted value
 * REPLACES `req[source]` (so handlers read typed, normalised input); on failure it throws the standard
 * `ErrUtils.validation` error (which the terminal error middleware serialises).
 *
 * `stripUnknown` is enabled so unexpected keys are dropped rather than rejected, and `abortEarly` is
 * off so the error `details` carry every failing field at once.
 */
export function validate(schema: Joi.ObjectSchema, source: ValidationSource = 'body'): RequestHandler {
  return async (req, _res, next) => {
    try {
      const value = await schema.validateAsync(req[source], {
        abortEarly: false,
        stripUnknown: true,
      });
      // `req.query`/`req.params` are typed read-only in Express 5; assign through `unknown`.
      (req as unknown as Record<ValidationSource, unknown>)[source] = value;
      next();
    } catch (err) {
      // Reduce to `{message, path, type, limit?}` per field — do NOT echo the offending input value.
      next(ErrUtils.validation('Validation error', sanitizeValidationDetails(err as Joi.ValidationError)));
    }
  };
}
