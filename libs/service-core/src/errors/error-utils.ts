import { RequestContext } from '../context/request-context';

/** Typed error categories mapped to HTTP status + a stable code. See docs/08-api-conventions.md. */
export enum ErrorType {
  Validation = 'VALIDATION',
  Unauthorized = 'UNAUTHORIZED',
  Forbidden = 'FORBIDDEN',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  RateLimit = 'RATE_LIMIT',
  Database = 'DATABASE',
  System = 'SYSTEM',
}

interface ErrorSpec {
  status: number;
  code: string;
}

const ERROR_MAP: Record<ErrorType, ErrorSpec> = {
  [ErrorType.Validation]: { status: 400, code: 'E_VALIDATION' },
  [ErrorType.Unauthorized]: { status: 401, code: 'E_UNAUTHORIZED' },
  [ErrorType.Forbidden]: { status: 403, code: 'E_FORBIDDEN' },
  [ErrorType.NotFound]: { status: 404, code: 'E_NOT_FOUND' },
  [ErrorType.Conflict]: { status: 409, code: 'E_CONFLICT' },
  [ErrorType.RateLimit]: { status: 429, code: 'E_RATE_LIMIT' },
  [ErrorType.Database]: { status: 500, code: 'E_DATABASE' },
  [ErrorType.System]: { status: 500, code: 'E_SYSTEM' },
};

/** The one error class every layer throws. The terminal error middleware serialises it. */
export class AppError extends Error {
  readonly type: ErrorType;
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly correlationId?: string;

  constructor(type: ErrorType, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.type = type;
    this.code = ERROR_MAP[type].code;
    this.status = ERROR_MAP[type].status;
    this.details = details;
    // The single tracking id, pulled from context when available (never throws).
    this.correlationId = RequestContext.tryGet()?.correlationId;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/** Factory of typed errors. Use the throw* helpers at call sites. */
export const ErrUtils = {
  validation: (message: string, details?: unknown) => new AppError(ErrorType.Validation, message, details),
  unauthorized: (message = 'Unauthorized', details?: unknown) => new AppError(ErrorType.Unauthorized, message, details),
  forbidden: (message = 'Forbidden', details?: unknown) => new AppError(ErrorType.Forbidden, message, details),
  notFound: (message: string, details?: unknown) => new AppError(ErrorType.NotFound, message, details),
  conflict: (message: string, details?: unknown) => new AppError(ErrorType.Conflict, message, details),
  rateLimit: (message = 'Too many requests', details?: unknown) => new AppError(ErrorType.RateLimit, message, details),
  database: (message: string, details?: unknown) => new AppError(ErrorType.Database, message, details),
  system: (message = 'Something went wrong', details?: unknown) => new AppError(ErrorType.System, message, details),

  throwValidation(message: string, details?: unknown): never {
    throw ErrUtils.validation(message, details);
  },
  throwForbidden(message?: string, details?: unknown): never {
    throw ErrUtils.forbidden(message, details);
  },
  throwNotFound(message: string, details?: unknown): never {
    throw ErrUtils.notFound(message, details);
  },
  throwSystem(message?: string, details?: unknown): never {
    throw ErrUtils.system(message, details);
  },

  isAppError(err: unknown): err is AppError {
    return err instanceof AppError;
  },
};
