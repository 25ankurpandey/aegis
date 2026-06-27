import { ConnectorKind } from '@aegis/shared-enums';
import { ErrUtils } from '@aegis/service-core';
import type { Connector } from './connector';

/** Holds the available connector adapters, keyed by kind. The strategy chosen per tenant config. */
export class ConnectorRegistry {
  private static connectors = new Map<ConnectorKind, Connector>();

  static register(connector: Connector): void {
    ConnectorRegistry.connectors.set(connector.kind, connector);
  }

  static get(kind: ConnectorKind): Connector {
    const connector = ConnectorRegistry.connectors.get(kind);
    if (!connector) {
      throw ErrUtils.system(`No connector registered for kind '${kind}'`);
    }
    return connector;
  }

  static list(): ConnectorKind[] {
    return [...ConnectorRegistry.connectors.keys()];
  }
}
