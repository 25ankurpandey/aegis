import type { RequestHandler } from 'express';
import { Logger } from '../logging/logger';

/** Logs each request's method/path/status/duration; correlationId is auto-attached by the Logger. */
export const requestLogMiddleware: RequestHandler = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    Logger.info('request', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start,
    });
  });
  next();
};
