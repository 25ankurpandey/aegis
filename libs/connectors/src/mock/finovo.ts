import { ConnectorKind } from '@aegis/shared-enums';
import { BaseConnector } from '../base-connector';
import { AbstractTransformer, type ErpPayload } from '../transformer';
import type { ConnectorConfig, ConnectorStatusResult, PushRequest, PushResult } from '../connector';

/**
 * Finovo payload shape (API-key style): a nested "document" with the amount kept in minor units and
 * a typed kind, distinct from LedgerOne's flat shape — proving each connector maps the same domain
 * entity to its own wire format via its own transformer.
 */
export class FinovoTransformer extends AbstractTransformer {
  readonly kind = ConnectorKind.Finovo;

  protected buildBody(req: PushRequest): ErpPayload {
    return {
      document: {
        type: req.entity,
        reference: req.externalRefHint ?? req.idempotencyKey,
        amountMinor: req.data['totalAmount'] ?? req.data['amount'] ?? 0, // ERP expects minor units
        currencyCode: req.data['currency'] ?? 'USD',
      },
    };
  }
}

/** Mock ERP that queues a transaction on push and reports it synced on a later status poll. */
export class FinovoConnector extends BaseConnector {
  readonly kind = ConnectorKind.Finovo;
  protected override get transformer(): FinovoTransformer {
    return new FinovoTransformer();
  }

  protected async doPush(_config: ConnectorConfig, req: PushRequest, payload: ErpPayload): Promise<PushResult> {
    return { accepted: true, externalId: this.externalIdFor(req), status: 'queued', payload };
  }

  protected async doStatus(_config: ConnectorConfig, externalId: string): Promise<ConnectorStatusResult> {
    return { externalId, status: 'synced' };
  }
}
