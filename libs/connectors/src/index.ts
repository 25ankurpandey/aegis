/**
 * @aegis/connectors — pluggable ERP integration framework (adapter/strategy + registry).
 * Ships MOCK connectors (LedgerOne, Finovo, AcctBridge) that emulate ERP behaviour without real
 * network calls, proving the infrastructure is production-ready: a real ERP plugs in via one
 * adapter implementing `Connector`. See docs/services/connectors.md.
 */
import { ConnectorRegistry } from './registry';
import { LedgerOneConnector } from './mock/ledger-one';
import { FinovoConnector } from './mock/finovo';
import { AcctBridgeConnector } from './mock/acct-bridge';

export * from './connector';
export * from './transformer';
export * from './base-connector';
export * from './registry';
export * from './errors';
export * from './sync-state';
export * from './config-store';
export { LedgerOneConnector, LedgerOneTransformer } from './mock/ledger-one';
export { FinovoConnector, FinovoTransformer } from './mock/finovo';
export { AcctBridgeConnector, AcctBridgeTransformer } from './mock/acct-bridge';

/** Register the built-in mock connectors. Call once at service bootstrap. */
export function registerBuiltinConnectors(): void {
  ConnectorRegistry.register(new LedgerOneConnector());
  ConnectorRegistry.register(new FinovoConnector());
  ConnectorRegistry.register(new AcctBridgeConnector());
}

// Auto-register on import so consumers get the mocks out of the box.
registerBuiltinConnectors();
