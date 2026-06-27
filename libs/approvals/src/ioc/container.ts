import 'reflect-metadata';
import { Container, type interfaces } from 'inversify';
import { fluentProvide, buildProviderModule } from 'inversify-binding-decorators';

/**
 * The approvals lib's DI container. Repositories and the engine self-register via
 * `@provideSingleton` (class-as-token, singleton scope) — the same pattern every Aegis service uses.
 * A consuming service can either resolve the engine from this container directly or rebind the
 * repositories into its own container; the lib stays self-contained either way.
 */
export const approvalsContainer = new Container();

/** Decorator helper: bind a class to itself in singleton scope (class-as-token). */
export const provideSingleton = (identifier: interfaces.ServiceIdentifier<unknown>) =>
  fluentProvide(identifier).inSingletonScope().done();

let loaded = false;

/**
 * Load every `@provideSingleton`-decorated binding into {@link approvalsContainer}. Lazy +
 * idempotent so importing the lib doesn't eagerly build the container at module-eval time (which
 * would run before the decorators are registered).
 */
export function loadApprovalsModule(): void {
  if (loaded) return;
  approvalsContainer.load(buildProviderModule());
  loaded = true;
}

