/**
 * @aegis/service-core — the cross-cutting backbone every service shares:
 * request context, logging, errors + envelope, context-propagating HTTP client,
 * config/secrets, cache, and the middleware/bootstrap helpers.
 */
export * from './context/context.types';
export * from './context/request-context';
export * from './errors/error-utils';
export * from './logging/logger';
export * from './middleware/context.middleware';
export * from './middleware/error.middleware';
export * from './middleware/request-log.middleware';
export * from './middleware/validation.middleware';
export * from './middleware/audit.middleware';
export * from './middleware/cors.middleware';
export * from './middleware/idempotency.middleware';
export * from './auth/internal-auth';
export * from './http/http-client';
export * from './http/response-envelope';
export * from './http/record-annotation-query';
export * from './config/config';
export * from './config/service-env';
export * from './config/secrets';
export * from './config/feature-flags';
export * from './cache/cache-adapter';
export * from './cache/flag-cache';
export * from './bootstrap/bootstrap';
export * from './bootstrap/shutdown';
export * from './bootstrap/pep-assertion';
