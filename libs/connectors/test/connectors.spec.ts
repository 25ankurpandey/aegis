import { ConnectorKind, ConnectorEntity } from '@aegis/shared-enums';
import { ConnectorRegistry, registerBuiltinConnectors } from '../src/index';
import type { ConnectorConfig, PushRequest } from '../src/connector';

const config = (kind: ConnectorKind): ConnectorConfig => ({ kind, tenantId: 't1' });
const req = (over: Partial<PushRequest> = {}): PushRequest => ({
  entity: ConnectorEntity.Expense,
  idempotencyKey: 'idem-1',
  data: { amount: 1000 },
  ...over,
});

describe('@aegis/connectors', () => {
  beforeAll(() => registerBuiltinConnectors());

  it('registers the three mock connectors', () => {
    expect(ConnectorRegistry.list()).toEqual(
      expect.arrayContaining([ConnectorKind.LedgerOne, ConnectorKind.Finovo, ConnectorKind.AcctBridge]),
    );
  });

  it('LedgerOne syncs immediately', async () => {
    const res = await ConnectorRegistry.get(ConnectorKind.LedgerOne).pushTransaction(config(ConnectorKind.LedgerOne), req());
    expect(res.accepted).toBe(true);
    expect(res.status).toBe('synced');
  });

  it('is idempotent — same key returns the same result', async () => {
    const c = ConnectorRegistry.get(ConnectorKind.Finovo);
    const first = await c.pushTransaction(config(ConnectorKind.Finovo), req({ idempotencyKey: 'k2' }));
    const second = await c.pushTransaction(config(ConnectorKind.Finovo), req({ idempotencyKey: 'k2' }));
    expect(second.externalId).toBe(first.externalId);
  });

  it('AcctBridge validates payload (amount required)', async () => {
    const res = await ConnectorRegistry.get(ConnectorKind.AcctBridge).pushTransaction(
      config(ConnectorKind.AcctBridge),
      req({ idempotencyKey: 'k3', data: {} }),
    );
    expect(res.accepted).toBe(false);
    expect(res.status).toBe('error');
  });

  it('applies each connector’s transformer (domain entity → ERP-specific payload)', async () => {
    // LedgerOne: flat journalEntry with amount in MAJOR units (1000 minor → 10 major).
    const ledger = await ConnectorRegistry.get(ConnectorKind.LedgerOne).pushTransaction(
      config(ConnectorKind.LedgerOne),
      req({ idempotencyKey: 'tf-ledger', data: { totalAmount: 1000, currency: 'USD', name: 'Q3 expenses' } }),
    );
    expect((ledger.payload as any).journalEntry.amount).toBe(10);
    expect((ledger.payload as any).journalEntry.memo).toBe('Q3 expenses');

    // Finovo: nested document with amount kept in MINOR units — a different shape from the same entity.
    const finovo = await ConnectorRegistry.get(ConnectorKind.Finovo).pushTransaction(
      config(ConnectorKind.Finovo),
      req({ idempotencyKey: 'tf-finovo', data: { totalAmount: 1000, currency: 'USD' } }),
    );
    expect((finovo.payload as any).document.amountMinor).toBe(1000);
    expect((finovo.payload as any).document.type).toBe(ConnectorEntity.Expense);
  });
});
