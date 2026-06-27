import type { Request, RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { HttpHeaderKey, type ServiceName } from '@aegis/shared-enums';
import { Config } from '../config/config';
import { ErrUtils } from '../errors/error-utils';
import { RequestContext } from '../context/request-context';
import { markAuthGuard } from '../bootstrap/pep-assertion';

const AUDIENCE = 'aegis-internal';

/**
 * Mints a short-lived signed internal token (issuer/audience/exp — NOT an empty-payload token).
 * Carries the calling service so the callee can attribute the call. See docs/06-service-to-service.md.
 */
export function signInternalToken(sourceService: ServiceName): string {
  return jwt.sign({ iss: 'aegis', src: sourceService }, Config.require('INTERNAL_JWT_SECRET'), {
    audience: AUDIENCE,
    expiresIn: 300,
  });
}

export function verifyInternalToken(token: string): jwt.JwtPayload {
  return jwt.verify(token, Config.require('INTERNAL_JWT_SECRET'), { audience: AUDIENCE }) as jwt.JwtPayload;
}

function header(req: Request, key: HttpHeaderKey): string | undefined {
  const v = req.headers[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Guards internal-only routes: requires the X-Internal-Origin gate AND a valid signed internal
 * token. Records the source service on the request context for audit attribution. Fail-closed.
 */
export function internalAuth(): RequestHandler {
  return markAuthGuard((req, _res, next) => {
    if (header(req, HttpHeaderKey.InternalOrigin) !== Config.get('INTERNAL_ORIGIN', 'aegis-internal')) {
      return next(ErrUtils.forbidden('Not an internal request'));
    }
    const token = header(req, HttpHeaderKey.InternalToken);
    if (!token) {
      return next(ErrUtils.unauthorized('Missing internal token'));
    }
    try {
      const payload = verifyInternalToken(token);
      RequestContext.set('sourceService', payload['src'] as ServiceName);
    } catch {
      return next(ErrUtils.unauthorized('Invalid internal token'));
    }
    return next();
  });
}
