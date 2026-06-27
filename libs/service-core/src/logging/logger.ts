import pino from 'pino';
import { RequestContext } from '../context/request-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Marker stamped on every `Logger.alert(...)` line. A log sink / alerting rule keys off
 * `{ alert: true }` (or the `fatal` pino level) to page on-call for high-severity ops events.
 */
export const ALERT_MARKER = 'alert' as const;

/**
 * Structured logger (pino). Every line is auto-enriched from RequestContext so a single
 * `correlationId` stitches a logical operation across services. Safe off the request path.
 */
export class Logger {
  private static logger: pino.Logger = pino({ level: process.env.LOG_LEVEL || 'info' });

  static init(serviceName: string, opts?: { level?: LogLevel }): void {
    Logger.logger = pino({
      level: opts?.level || process.env.LOG_LEVEL || 'info',
      base: { serviceName },
    });
  }

  private static enrich(data?: Record<string, unknown>): Record<string, unknown> {
    const ctx = RequestContext.tryGet();
    return {
      ...(ctx
        ? {
            correlationId: ctx.correlationId,
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            caller: ctx.caller,
          }
        : {}),
      ...data,
    };
  }

  static debug(message: string, data?: Record<string, unknown>): void {
    Logger.logger.debug(Logger.enrich(data), message);
  }

  static info(message: string, data?: Record<string, unknown>): void {
    Logger.logger.info(Logger.enrich(data), message);
  }

  static warn(message: string, data?: Record<string, unknown>): void {
    Logger.logger.warn(Logger.enrich(data), message);
  }

  static error(err: Error, errId?: string, errType?: string, data?: Record<string, unknown>): void {
    Logger.logger.error(
      Logger.enrich({ errId, errType, stack: err.stack, ...data }),
      err.message,
    );
  }

  /**
   * High-severity ops channel. Emits at pino's `fatal` level and stamps `{ alert: true }` so an
   * alerting sink can page on-call. Use for events that need human attention right now — failed
   * graceful drain, DLQ-publish failures, repeated downstream outages — NOT for ordinary 5xx noise.
   */
  static alert(message: string, data?: Record<string, unknown>): void {
    Logger.logger.fatal(Logger.enrich({ [ALERT_MARKER]: true, ...data }), message);
  }
}
