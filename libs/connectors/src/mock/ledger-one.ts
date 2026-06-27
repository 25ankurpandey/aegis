import { ConnectorKind } from '@aegis/shared-enums';
import { BaseConnector } from '../base-connector';
import { AbstractTransformer, type ErpPayload } from '../transformer';
import type { ConnectorConfig, ConnectorStatusResult, PushRequest, PushResult } from '../connector';

/**
 * LedgerOne payload shape (OAuth2 cloud-accounting style): a flat "journalEntry" envelope with the
 * amount in major units and a source-document reference — the connector-specific mapping of the
 * domain entity, mirroring the donor's per-ERP `*_bill_transformer.payload()`.
 */
export class LedgerOneTransformer extends AbstractTransformer {
  readonly kind = ConnectorKind.LedgerOne;

  protected buildBody(req: PushRequest): ErpPayload {
    const amount = req.data['totalAmount'] ?? req.data['amount'];
    return {
      journalEntry: {
        sourceRef: req.externalRefHint ?? req.idempotencyKey,
        memo: req.data['name'] ?? req.data['merchant'] ?? '',
        currency: req.data['currency'] ?? 'USD',
        amount: typeof amount === 'number' ? amount / 100 : amount, // ERP expects major units
      },
    };
  }
}

/** Mock ERP that accepts and "syncs" a transaction immediately (no real network call). */
export class LedgerOneConnector extends BaseConnector {
  readonly kind = ConnectorKind.LedgerOne;
  protected override get transformer(): LedgerOneTransformer {
    return new LedgerOneTransformer();
  }

  protected async doPush(_config: ConnectorConfig, req: PushRequest, payload: ErpPayload): Promise<PushResult> {
    return { accepted: true, externalId: this.externalIdFor(req), status: 'synced', payload };
  }

  protected async doStatus(_config: ConnectorConfig, externalId: string): Promise<ConnectorStatusResult> {
    return { externalId, status: 'synced' };
  }
}
