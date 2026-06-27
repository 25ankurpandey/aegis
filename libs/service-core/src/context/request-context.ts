import { AsyncLocalStorage } from 'node:async_hooks';
import type { SourceService } from '@aegis/shared-enums';
import type { RequestContextData } from './context.types';

/**
 * The single ambient per-request store, backed by Node's native AsyncLocalStorage.
 * Replaces the donor's cls-hooked namespace. HTTP middleware and non-HTTP entrypoints
 * (workers, event consumers) both open a scope with `run`.
 */
export class RequestContext {
  private static als = new AsyncLocalStorage<RequestContextData>();

  /** Run `fn` within a fresh context scope. */
  static run<T>(seed: RequestContextData, fn: () => T): T {
    return RequestContext.als.run(seed, fn);
  }

  /** The whole context, or throw if called outside a scope (fail-closed). */
  static get(): RequestContextData {
    const ctx = RequestContext.als.getStore();
    if (!ctx) {
      throw new Error('RequestContext accessed outside of a context scope');
    }
    return ctx;
  }

  /** The whole context or undefined (safe off the request path — used by the Logger). */
  static tryGet(): RequestContextData | undefined {
    return RequestContext.als.getStore();
  }

  /** Mutate the active context in place (e.g. the PEP sets userId/roles post-auth). */
  static set<K extends keyof RequestContextData>(key: K, value: RequestContextData[K]): void {
    const ctx = RequestContext.als.getStore();
    if (ctx) {
      ctx[key] = value;
    }
  }

  static tenantId(): string {
    const { tenantId } = RequestContext.get();
    if (!tenantId) {
      throw new Error('tenantId is not set on the request context');
    }
    return tenantId;
  }

  static userId(): string | undefined {
    return RequestContext.tryGet()?.userId;
  }

  static roles(): string[] {
    return RequestContext.tryGet()?.roles ?? [];
  }

  static correlationId(): string {
    return RequestContext.get().correlationId;
  }

  static callerName(): string | undefined {
    return RequestContext.tryGet()?.caller;
  }

  static sourceService(): SourceService | undefined {
    return RequestContext.tryGet()?.sourceService;
  }

  static token(): string | undefined {
    return RequestContext.tryGet()?.token;
  }
}
