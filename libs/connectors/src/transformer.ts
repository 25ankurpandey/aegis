import type { ConnectorKind } from '@aegis/shared-enums';
import type { ConnectorConfig, PushRequest } from './connector';

/**
 * The ERP-specific push payload a {@link Transformer} produces from a domain entity. Each ERP has
 * its own wire shape, so this is an opaque record — only the owning connector's `doPush` reads it.
 */
export type ErpPayload = Record<string, unknown>;

/**
 * Maps a domain entity (expense / invoice / payroll-journal, carried in `PushRequest.data`) into the
 * specific payload one ERP expects, mirroring the donor's per-ERP `*_bill_transformer.payload()`.
 *
 * A new ERP supplies ONE transformer; orchestration code (BaseConnector.pushTransaction) never
 * branches on the ERP — it resolves the connector, applies the connector's transformer, then pushes.
 * This is the strategy half of the adapter/strategy/factory decomposition (the registry is the
 * factory; the connector is the adapter; the transformer is the strategy for shaping the payload).
 */
export interface Transformer {
  /** The connector kind this transformer shapes payloads for (documentation / registry symmetry). */
  readonly kind: ConnectorKind;
  /**
   * Build the ERP-specific payload from a push request.
   * @param req    the domain transaction (entity + idempotency key + `data` domain entity).
   * @param config the resolved per-tenant connector config (settings/baseUrl may steer the shape).
   */
  transform(req: PushRequest, config: ConnectorConfig): ErpPayload;
}

/**
 * Default pass-through transformer: emits the domain `data` unchanged. Used when a connector does not
 * need to reshape the payload, so behaviour is identical to pushing `req.data` directly. Connectors
 * that need an ERP-specific shape subclass {@link AbstractTransformer} or implement {@link Transformer}.
 */
export class IdentityTransformer implements Transformer {
  constructor(readonly kind: ConnectorKind) {}

  transform(req: PushRequest, _config: ConnectorConfig): ErpPayload {
    return { ...req.data };
  }
}

/**
 * Convenience base for per-connector transformers: stamps the common envelope (entity kind, external
 * reference hint, idempotency key) and leaves the ERP-specific body to {@link buildBody}. Mirrors the
 * donor pattern where each transformer copies a base payload then overlays ERP-specific fields.
 */
export abstract class AbstractTransformer implements Transformer {
  abstract readonly kind: ConnectorKind;

  transform(req: PushRequest, config: ConnectorConfig): ErpPayload {
    return {
      entity: req.entity,
      idempotencyKey: req.idempotencyKey,
      externalRefHint: req.externalRefHint,
      ...this.buildBody(req, config),
    };
  }

  /** ERP-specific body overlaid onto the common envelope. */
  protected abstract buildBody(req: PushRequest, config: ConnectorConfig): ErpPayload;
}
