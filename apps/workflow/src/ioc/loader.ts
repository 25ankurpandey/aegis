import { buildProviderModule } from 'inversify-binding-decorators';
import { container } from './container';
import '../controllers'; // side-effect: evaluate @controller + @provideSingleton decorators

/** Load all decorator-registered providers (services/repositories) into the container. */
export function loadProviders(): void {
  container.load(buildProviderModule());
}
