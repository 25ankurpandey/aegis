import type { Request, RequestHandler } from 'express';
import { RequestContext } from '../context/request-context';
import { Logger } from '../logging/logger';

/** A single structured HTTP audit record. */
export interface HttpAuditRecord {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  correlationId?: string;
  userId?: string;
  tenantId?: string;
  caller?: string;
  ip?: string;
}

/** Pluggable sink so a host can persist audit records to a DB/audit table instead of (or as well as) logging. */
export type HttpAuditSink = (record: HttpAuditRecord) => void;

export interface HttpAuditOptions {
  /** Path prefixes excluded from auditing (probes/docs). Default: ['/health']. */
  excludePaths?: string[];
  /** Where to send each record. Default: structured `Logger.info('http.audit', ...)`. */
  sink?: HttpAuditSink;
}

const DEFAULT_EXCLUDE = ['/health'];

const defaultSink: HttpAuditSink = (record) => Logger.info('http.audit', { ...record });

/**
 * Cross-cutting HTTP request/response audit. Captures method, path, status, duration, correlationId,
 * userId, tenantId, caller, and ip as ONE structured record per request (on response `finish`). This
 * is the counterpart to the donor's `express-request-audit` band slot.
 *
 * Deliberately does NOT log request/response bodies or the `Authorization` header — only safe
 * metadata — so it can run on every route without leaking secrets or PII. Identity fields are read
 * from the RequestContext so they reflect the post-auth principal (the PEP sets userId/roles).
 */
export function auditMiddleware(opts: HttpAuditOptions = {}): RequestHandler {
  const exclude = opts.excludePaths ?? DEFAULT_EXCLUDE;
  const sink = opts.sink ?? defaultSink;
  return (req: Request, res, next) => {
    if (exclude.some((p) => req.path.startsWith(p))) {
      return next();
    }
    const start = Date.now();
    res.on('finish', () => {
      const ctx = RequestContext.tryGet();
      sink({
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - start,
        correlationId: ctx?.correlationId,
        userId: ctx?.userId,
        tenantId: ctx?.tenantId,
        caller: ctx?.caller,
        ip: req.ip,
      });
    });
    return next();
  };
}
