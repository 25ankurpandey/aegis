import { buildProviderModule } from 'inversify-binding-decorators';
import { registerApprovalProviders } from '@aegis/approvals';
import { container } from './container';
import '../controllers'; // side-effect: evaluate @controller + @provideSingleton decorators

/**
 * Load all decorator-registered providers (controllers/services/repositories) into the container.
 *
 * REUSABLE APPROVAL-ENGINE WIRING (the template expense/invoice copy): `registerApprovalProviders()`
 * evaluates the `@aegis/approvals` engine + repository decorators into the process-global
 * `inversify-binding-decorators` registry BEFORE the single `container.load(buildProviderModule())`,
 * so the one load binds the shared `ApprovalService` (and its repos) into THIS service's container
 * alongside its own providers. The pay-run service then just `@inject(ApprovalService)`. Do NOT load
 * the provider module a second time for approvals — the global registry means one load covers it.
 */
export function loadProviders(): void {
  registerApprovalProviders();
  container.load(buildProviderModule());
}
