import { Container, type interfaces } from 'inversify';
import { fluentProvide } from 'inversify-binding-decorators';

/** The service's DI container. Services/repositories self-register via @provideSingleton. */
export const container = new Container();

/** Decorator helper: bind a class to itself in singleton scope (class-as-token). */
export const provideSingleton = (identifier: interfaces.ServiceIdentifier<unknown>) =>
  fluentProvide(identifier).inSingletonScope().done();
