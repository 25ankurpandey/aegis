import type { ErrorRequestHandler } from 'express';
import { RequestContext } from '../context/request-context';
import { AppError, ErrUtils } from '../errors/error-utils';
import { Logger } from '../logging/logger';

/** Single error envelope (SPEC §9 / docs/08-api-conventions.md). */
interface ErrorEnvelope {
  errors: Array<{
    code: string;
    type: string;
    message: string;
    details?: unknown;
    correlationId?: string;
  }>;
}

/** Generic, safe message handed to the client for server-side (5xx) failures. */
const GENERIC_SERVER_MESSAGE = 'Internal server error';

/**
 * Terminal error handler. Normalises any thrown value into one AppError and emits the
 * `{ errors: [...] }` envelope with the HTTP status from the error.
 *
 * Info-leak guard: operational errors (4xx — validation/auth/conflict/etc.) carry messages that are
 * safe to return to the caller, so they pass through. Non-operational/server errors (5xx — System,
 * Database, or any unexpected throw) would otherwise leak `err.message`/internal `details` to the
 * client; for those we return a generic `display_message` and omit `details`, while the full original
 * error (message, details, stack) is logged server-side, correlated by `correlationId`.
 */
export const errorMiddleware: ErrorRequestHandler = (err, _req, res, _next) => {
  const appErr: AppError = ErrUtils.isAppError(err)
    ? err
    : ErrUtils.system(err instanceof Error ? err.message : 'Unexpected error');

  const correlationId = appErr.correlationId ?? RequestContext.tryGet()?.correlationId;

  // Always log the full, unredacted detail server-side (correlated). For a wrapped non-AppError we
  // log the ORIGINAL throw so the real stack/message survives, not the sanitised AppError copy.
  const logTarget = ErrUtils.isAppError(err) ? appErr : err instanceof Error ? err : appErr;
  Logger.error(logTarget, appErr.code, appErr.type, {
    status: appErr.status,
    details: appErr.details,
  });

  // 5xx errors are non-operational: never reveal the underlying message or internals to the client.
  const isServerError = appErr.status >= 500;

  const envelope: ErrorEnvelope = {
    errors: [
      {
        code: appErr.code,
        type: appErr.type,
        message: isServerError ? GENERIC_SERVER_MESSAGE : appErr.message,
        details: isServerError ? undefined : appErr.details,
        correlationId,
      },
    ],
  };

  res.status(appErr.status).json(envelope);
};
