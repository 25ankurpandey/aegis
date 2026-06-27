import { ConnectorKind } from '@aegis/shared-enums';
import { BaseConnector } from '../base-connector';
import { AbstractTransformer, type ErpPayload } from '../transformer';
import type { ConnectorConfig, ConnectorStatusResult, PushRequest, PushResult } from '../connector';

/**
 * AcctBridge payload shape (file-drop style): a CSV-row-like flat record keyed by ERP column names.
 * The transformer carries `amount` straight through from the domain entity so the connector can
 * reject a row that is missing it — demonstrating ERP-side validation against the transformed payload.
 */
export class AcctBridgeTransformer extends AbstractTransformer {
  readonly kind = ConnectorKind.AcctBridge;

  protected buildBody(req: PushRequest): ErpPayload {
    return {
      record: {
        ref: req.externalRefHint ?? req.idempotencyKey,
        amount: req.data['totalAmount'] ?? req.data['amount'], // undefined if the entity has none
        currency: req.data['currency'] ?? 'USD',
      },
    };
  }
}

/** Mock ERP that validates the payload (requires an `amount`) before "syncing" — shows error mapping. */
export class AcctBridgeConnector extends BaseConnector {
  readonly kind = ConnectorKind.AcctBridge;
  protected override get transformer(): AcctBridgeTransformer {
    return new AcctBridgeTransformer();
  }

  protected async doPush(_config: ConnectorConfig, req: PushRequest, payload: ErpPayload): Promise<PushResult> {
    const record = payload['record'] as { amount?: unknown } | undefined;
    if (record?.amount == null) {
      return { accepted: false, status: 'error', message: 'amount is required', payload };
    }
    return { accepted: true, externalId: this.externalIdFor(req), status: 'synced', payload };
  }

  protected async doStatus(_config: ConnectorConfig, externalId: string): Promise<ConnectorStatusResult> {
    return { externalId, status: 'synced' };
  }
}
